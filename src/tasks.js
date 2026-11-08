import { randomUUID } from 'node:crypto';
import { executeClaudeTask } from './claude.js';
import { HttpError } from './errors.js';

export const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);

const nowIso = () => new Date().toISOString();

function summarizeResult(result) {
  if (!result) return null;
  return {
    text: result.text ?? '',
    is_error: Boolean(result.is_error),
    subtype: result.subtype ?? null,
    session_id: result.session_id ?? null,
    total_cost_usd: result.total_cost_usd ?? null,
    duration_ms: result.duration_ms ?? null,
    duration_api_ms: result.duration_api_ms ?? null,
    num_turns: result.num_turns ?? null,
    stop_reason: result.stop_reason ?? null,
    terminal_reason: result.terminal_reason ?? null,
    usage: result.usage ?? null,
    permission_denials: result.permission_denials ?? [],
  };
}

export class TaskManager {
  constructor({ config, logger, runner = executeClaudeTask, store = null }) {
    this.config = config;
    this.logger = logger;
    this.runner = runner;
    this.store = store;
    this.tasks = new Map();
    this.queue = [];
    this.running = new Set();
    this.inflight = new Set();
    this.ttlTimer = null;
    this.startedAt = Date.now();

    if (config.taskTtlMs > 0) {
      this.ttlTimer = setInterval(() => this.sweep(), Math.min(60_000, config.taskTtlMs));
      this.ttlTimer.unref?.();
    }

    this.restoreTasks();
  }

  restoreTasks() {
    if (!this.store) return;
    const restored = this.store.loadAll();
    for (const stored of restored) {
      const task = {
        ...stored,
        subscribers: new Set(),
        controller: null,
        done: null,
      };
      this.tasks.set(task.id, task);

      if (task.status === 'queued' || task.status === 'running') {
        this.markInterrupted(task);
      }
    }
    if (restored.length > 0) {
      this.logger.info('restored tasks from disk', { count: restored.length, dir: this.store.tasksDir });
    }
  }

  markInterrupted(task) {
    const previousStatus = task.status;
    task.status = 'failed';
    task.finished_at = nowIso();
    task.error = {
      code: 'server_restarted',
      message: `Server restarted while the task was ${previousStatus}; the Claude Code process is no longer running`,
      details: { previous_status: previousStatus },
    };
    this.store?.writeMeta(task);
    this.emit(task, 'error', { code: task.error.code, message: task.error.message, details: task.error.details });
    this.emit(task, 'status', { status: 'failed', error_code: 'server_restarted', duration_ms: null });
    this.logger.warn('task marked failed after restart', { task_id: task.id, previous_status: previousStatus });
  }

  createTask({ prompt, cwd, options = {} }) {
    const capacityAvailable = this.running.size < this.config.maxConcurrentTasks && this.queue.length === 0;
    if (!capacityAvailable && this.queue.length >= this.config.maxQueueSize) {
      throw new HttpError(
        429,
        'queue_full',
        `Task queue is full (${this.queue.length}/${this.config.maxQueueSize} waiting, ${this.running.size}/${this.config.maxConcurrentTasks} running)`,
      );
    }

    const task = {
      id: `tsk_${randomUUID()}`,
      status: 'queued',
      prompt,
      cwd,
      options,
      created_at: nowIso(),
      started_at: null,
      finished_at: null,
      result: null,
      error: null,
      events: [],
      eventBytes: 0,
      eventsTruncated: false,
      lastSeq: 0,
      subscribers: new Set(),
      controller: null,
      done: null,
    };

    this.store?.createTask(task);
    this.tasks.set(task.id, task);
    this.emit(task, 'status', { status: 'queued' });
    this.queue.push(task);
    this.pump();
    return task;
  }

  getTask(id) {
    return this.tasks.get(id) ?? null;
  }

  listTasks({ limit = 50 } = {}) {
    const all = [...this.tasks.values()].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    return all.slice(0, limit);
  }

  snapshot(task) {
    const queuePosition = task.status === 'queued' ? this.queue.indexOf(task) + 1 : null;
    return {
      task_id: task.id,
      status: task.status,
      created_at: task.created_at,
      started_at: task.started_at,
      finished_at: task.finished_at,
      cwd: task.cwd,
      prompt: task.prompt,
      options: task.options,
      queue_position: queuePosition > 0 ? queuePosition : null,
      result: task.result,
      error: task.error,
      events_buffered: task.events.length,
      events_truncated: task.eventsTruncated,
      last_seq: task.lastSeq,
    };
  }

  getEventsFrom(task, fromSeq) {
    return task.events.filter((record) => record.seq > fromSeq);
  }

  subscribe(task, listener) {
    task.subscribers.add(listener);
    return () => task.subscribers.delete(listener);
  }

  emit(task, event, data) {
    const seq = ++task.lastSeq;
    const record = { seq, event, data: { ...data, task_id: task.id, seq } };

    const isProcess = event === 'process';
    const overCount = task.events.length >= this.config.maxEventsPerTask;
    const overBytes = task.eventBytes >= this.config.sseMaxBufferBytes;

    if (isProcess && (overCount || overBytes)) {
      if (!task.eventsTruncated) {
        task.eventsTruncated = true;
        const notice = {
          seq: ++task.lastSeq,
          event: 'process',
          data: {
            kind: 'notice',
            code: 'events_truncated',
            message: 'Replay buffer limit reached; earlier process events are no longer stored',
            task_id: task.id,
          },
        };
        notice.data.seq = notice.seq;
        this.broadcast(task, notice);
      }
    } else {
      task.events.push(record);
      task.eventBytes += Buffer.byteLength(JSON.stringify(record.data));
      this.store?.appendEvent(task.id, record);
    }

    this.broadcast(task, record);
    if (event !== 'process') {
      // Only state transitions need a fresh snapshot; appending every process
      // event to meta.json would rewrite the file for each token delta.
      this.store?.writeMeta(task);
    }
    return record;
  }

  broadcast(task, record) {
    for (const listener of task.subscribers) {
      try {
        listener(record);
      } catch (error) {
        this.logger.error('sse subscriber failed', { task_id: task.id, error: error.message });
        task.subscribers.delete(listener);
      }
    }
  }

  pump() {
    while (this.running.size < this.config.maxConcurrentTasks && this.queue.length > 0) {
      const task = this.queue.shift();
      this.startTask(task);
    }
  }

  startTask(task) {
    task.status = 'running';
    task.started_at = nowIso();
    task.controller = new AbortController();
    this.running.add(task);
    const log = this.logger.child({ task_id: task.id });
    this.emit(task, 'status', { status: 'running' });

    const timeoutMs = task.options.timeout_ms ?? this.config.defaultTaskTimeoutMs;
    log.info('task started', { cwd: task.cwd, timeout_ms: timeoutMs, model: task.options.model ?? null });

    const promise = this.runner({
      prompt: task.prompt,
      cwd: task.cwd,
      options: task.options,
      timeoutMs,
      signal: task.controller.signal,
      config: this.config,
      logger: log,
      onProcessEvent: (event) => this.emit(task, 'process', { phase: 'process', ...event }),
    })
      .then((outcome) => this.finishTask(task, outcome))
      .catch((error) => {
        log.error('task runner crashed', { error: error.message, stack: error.stack });
        this.finishTask(task, {
          result: null,
          exit_code: null,
          timed_out: false,
          cancelled: false,
          error: { code: 'internal_error', message: `Task runner failed: ${error.message}` },
        });
      })
      .finally(() => {
        this.inflight.delete(promise);
      });

    this.inflight.add(promise);
    task.done = promise;
  }

  finishTask(task, outcome) {
    if (TERMINAL_STATUSES.has(task.status)) return;
    task.finished_at = nowIso();
    this.running.delete(task);

    if (outcome.error) {
      task.error = {
        code: outcome.error.code,
        message: outcome.error.message,
        details: outcome.error.details ?? null,
      };
      task.status = outcome.error.code === 'timeout' ? 'timed_out' : outcome.error.code === 'cancelled' ? 'cancelled' : 'failed';
      this.store?.writeMeta(task);
      this.emit(task, 'error', {
        code: task.error.code,
        message: task.error.message,
        details: task.error.details,
        exit_code: outcome.exit_code ?? null,
        stderr_tail: outcome.stderr_tail ?? null,
      });
    } else {
      task.result = summarizeResult(outcome.result);
      task.status = 'succeeded';
      this.store?.writeMeta(task);
      this.emit(task, 'result', { final: true, ...task.result });
    }

    this.emit(task, 'status', {
      status: task.status,
      error_code: task.error?.code ?? null,
      duration_ms:
        task.started_at && task.finished_at
          ? new Date(task.finished_at).getTime() - new Date(task.started_at).getTime()
          : null,
    });

    this.logger.info('task finished', {
      task_id: task.id,
      status: task.status,
      error_code: task.error?.code ?? null,
      cost_usd: task.result?.total_cost_usd ?? null,
    });

    this.pump();
  }

  cancelTask(id) {
    const task = this.tasks.get(id);
    if (!task) throw new HttpError(404, 'task_not_found', `Task ${id} does not exist`);

    if (TERMINAL_STATUSES.has(task.status)) {
      throw new HttpError(409, 'task_already_terminal', `Task ${id} is already in terminal state "${task.status}"`, {
        status: task.status,
      });
    }

    if (task.status === 'queued') {
      this.queue = this.queue.filter((item) => item.id !== task.id);
      task.finished_at = nowIso();
      task.status = 'cancelled';
      task.error = { code: 'cancelled', message: 'Task cancelled before execution', details: null };
      this.emit(task, 'error', { code: 'cancelled', message: task.error.message, details: null });
      this.emit(task, 'status', { status: 'cancelled', error_code: 'cancelled', duration_ms: null });
      this.logger.info('task cancelled while queued', { task_id: task.id });
      return { task_id: task.id, status: 'cancelled', accepted: true };
    }

    this.logger.info('task cancellation requested', { task_id: task.id });
    task.controller?.abort();
    return { task_id: task.id, status: 'running', accepted: true, message: 'Cancellation signalled' };
  }

  sweep() {
    const cutoff = Date.now() - this.config.taskTtlMs;
    for (const [id, task] of this.tasks) {
      if (!TERMINAL_STATUSES.has(task.status)) continue;
      if (task.subscribers.size > 0) continue;
      const ts = task.finished_at ? new Date(task.finished_at).getTime() : new Date(task.created_at).getTime();
      if (ts < cutoff) {
        this.tasks.delete(id);
        this.store?.deleteTask(id);
        this.logger.info('task expired and removed', { task_id: id });
      }
    }
  }

  stats() {
    return {
      tasks_total: this.tasks.size,
      running: this.running.size,
      queued: this.queue.length,
      max_concurrent_tasks: this.config.maxConcurrentTasks,
      max_queue_size: this.config.maxQueueSize,
      uptime_s: Math.floor((Date.now() - this.startedAt) / 1000),
    };
  }

  async shutdown(timeoutMs = 10_000) {
    if (this.ttlTimer) clearInterval(this.ttlTimer);
    for (const task of this.running) {
      task.controller?.abort();
    }
    if (this.inflight.size === 0) return;
    const wait = Promise.allSettled([...this.inflight]);
    await Promise.race([wait, new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
  }
}
