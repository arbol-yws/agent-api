import fs from 'node:fs';
import path from 'node:path';

const TASK_ID_PATTERN = /^tsk_[0-9a-fA-F-]+$/;

/**
 * File-backed task storage.
 *
 * Layout:
 *   <STATE_DIR>/tasks/<task_id>/meta.json      atomically replaced snapshot
 *   <STATE_DIR>/tasks/<task_id>/events.jsonl   append-only SSE event log
 *
 * Crash safety:
 *   - meta.json is written to a temp file, fsynced, then renamed over the
 *     target, so readers never see a half-written snapshot.
 *   - events.jsonl is append-only. On load, a trailing line without a newline
 *     is discarded (and truncated from disk), so a partially written record is
 *     never surfaced as an event.
 */
export class TaskStore {
  constructor({ dir, logger }) {
    this.dir = dir;
    this.logger = logger;
    this.tasksDir = path.join(dir, 'tasks');
  }

  init() {
    fs.mkdirSync(this.tasksDir, { recursive: true });
  }

  taskDir(taskId) {
    if (!TASK_ID_PATTERN.test(taskId)) throw new Error(`Invalid task id for storage: ${taskId}`);
    return path.join(this.tasksDir, taskId);
  }

  createTask(task) {
    try {
      fs.mkdirSync(this.taskDir(task.id), { recursive: true });
      return this.writeMeta(task);
    } catch (error) {
      this.logger?.error('state store: create task failed', { task_id: task.id, error: error.message });
      return false;
    }
  }

  writeMeta(task) {
    const meta = {
      version: 1,
      task_id: task.id,
      status: task.status,
      prompt: task.prompt,
      cwd: task.cwd,
      options: task.options ?? {},
      created_at: task.created_at,
      started_at: task.started_at,
      finished_at: task.finished_at,
      result: task.result,
      error: task.error,
      last_seq: task.lastSeq,
      events_truncated: task.eventsTruncated,
    };
    try {
      this.atomicWrite(path.join(this.taskDir(task.id), 'meta.json'), JSON.stringify(meta));
      return true;
    } catch (error) {
      this.logger?.error('state store: write meta failed', { task_id: task.id, error: error.message });
      return false;
    }
  }

  atomicWrite(filePath, content) {
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    const fd = fs.openSync(tmpPath, 'w');
    try {
      fs.writeSync(fd, content);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, filePath);
  }

  appendEvent(taskId, record) {
    const line = `${JSON.stringify(record)}\n`;
    try {
      fs.appendFileSync(path.join(this.taskDir(taskId), 'events.jsonl'), line, 'utf8');
      return true;
    } catch (error) {
      this.logger?.error('state store: append event failed', { task_id: taskId, error: error.message });
      return false;
    }
  }

  deleteTask(taskId) {
    try {
      fs.rmSync(this.taskDir(taskId), { recursive: true, force: true });
      return true;
    } catch (error) {
      this.logger?.error('state store: delete task failed', { task_id: taskId, error: error.message });
      return false;
    }
  }

  loadAll() {
    let entries;
    try {
      entries = fs.readdirSync(this.tasksDir, { withFileTypes: true });
    } catch (error) {
      this.logger?.warn('state store: cannot read tasks directory', { dir: this.tasksDir, error: error.message });
      return [];
    }

    const tasks = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !TASK_ID_PATTERN.test(entry.name)) continue;
      const taskId = entry.name;
      const dir = path.join(this.tasksDir, taskId);

      let meta;
      try {
        meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
      } catch (error) {
        this.logger?.warn('state store: skipping task with unreadable meta', { task_id: taskId, error: error.message });
        continue;
      }

      const events = this.readEvents(path.join(dir, 'events.jsonl'));
      const task = this.rebuildTask(meta, events, taskId);
      tasks.push(task);
    }
    return tasks;
  }

  readEvents(filePath) {
    let buffer;
    try {
      buffer = fs.readFileSync(filePath);
    } catch {
      return [];
    }

    // Discard a trailing record that was not fully written before a crash.
    const lastNewline = buffer.lastIndexOf(0x0a);
    if (lastNewline === -1) {
      if (buffer.length > 0) fs.truncateSync(filePath, 0);
      return [];
    }
    if (lastNewline !== buffer.length - 1) {
      try {
        fs.truncateSync(filePath, lastNewline + 1);
        this.logger?.warn('state store: truncated incomplete event record', { file: filePath });
      } catch (error) {
        this.logger?.warn('state store: failed to truncate partial event record', { file: filePath, error: error.message });
      }
    }

    const events = [];
    for (const line of buffer.subarray(0, lastNewline + 1).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (record && Number.isInteger(record.seq) && typeof record.event === 'string') events.push(record);
      } catch {
        this.logger?.warn('state store: ignoring corrupt event line', { file: filePath });
      }
    }
    return events;
  }

  rebuildTask(meta, events, taskId) {
    const lastStatus = [...events].reverse().find((record) => record.event === 'status');
    const lastResult = [...events].reverse().find((record) => record.event === 'result');
    const lastError = [...events].reverse().find((record) => record.event === 'error');

    let status = typeof meta.status === 'string' ? meta.status : 'queued';
    let result = meta.result ?? null;
    let error = meta.error ?? null;

    // If the process crashed after appending a terminal event but before
    // rewriting meta.json, trust the event log so a finished task is not
    // misreported as interrupted on the next start.
    if (lastStatus && ['succeeded', 'failed', 'cancelled', 'timed_out'].includes(lastStatus.data?.status)) {
      status = lastStatus.data.status;
      if (!result && lastResult) {
        const { final, task_id, seq, ...rest } = lastResult.data ?? {}; // eslint-disable-line no-unused-vars
        result = rest;
      }
      if (!error && lastError) {
        error = {
          code: lastError.data?.code ?? 'unknown',
          message: lastError.data?.message ?? '',
          details: lastError.data?.details ?? null,
        };
      }
    }

    const lastSeq = events.reduce((max, record) => Math.max(max, record.seq), Number.isInteger(meta.last_seq) ? meta.last_seq : 0);
    const eventBytes = events.reduce((total, record) => total + Buffer.byteLength(JSON.stringify(record.data)), 0);

    return {
      id: typeof meta.task_id === 'string' && TASK_ID_PATTERN.test(meta.task_id) ? meta.task_id : taskId,
      status,
      prompt: meta.prompt ?? '',
      cwd: meta.cwd ?? '',
      options: meta.options ?? {},
      created_at: meta.created_at ?? new Date().toISOString(),
      started_at: meta.started_at ?? null,
      finished_at: meta.finished_at ?? null,
      result: result ?? null,
      error: error ?? null,
      events,
      eventBytes,
      eventsTruncated: Boolean(meta.events_truncated),
      lastSeq,
    };
  }
}
