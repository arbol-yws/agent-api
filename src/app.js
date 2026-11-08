import fs from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import express from 'express';
import { HttpError } from './errors.js';
import { describeCredentials } from './config.js';
import { TERMINAL_STATUSES } from './tasks.js';

const MAX_PROMPT_CHARS = 100_000;
const MAX_SYSTEM_PROMPT_CHARS = 100_000;
const PERMISSION_MODES = ['default', 'acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'];

function bearerMatches(header, expected) {
  if (typeof header !== 'string') return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return false;
  const provided = Buffer.from(match[1]);
  const expectedBuffer = Buffer.from(expected);
  if (provided.length !== expectedBuffer.length) return false;
  return timingSafeEqual(provided, expectedBuffer);
}

function parseSeq(value, fallback = 0) {
  const num = Number(value);
  if (!Number.isInteger(num) || num < 0) return fallback;
  return num;
}

function resolveCwd(rawCwd, config) {
  if (rawCwd === undefined || rawCwd === null || rawCwd === '') return config.workspaceDir;
  if (typeof rawCwd !== 'string') {
    throw new HttpError(400, 'invalid_cwd', 'cwd must be a string relative to WORKSPACE_DIR');
  }
  if (path.isAbsolute(rawCwd)) {
    throw new HttpError(400, 'invalid_cwd', 'cwd must be relative to WORKSPACE_DIR, absolute paths are not allowed');
  }
  const target = path.resolve(config.workspaceDir, rawCwd);
  const relative = path.relative(config.workspaceDir, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new HttpError(400, 'invalid_cwd', `cwd escapes WORKSPACE_DIR (${config.workspaceDir})`);
  }
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    throw new HttpError(400, 'invalid_cwd', `cwd does not exist: ${rawCwd}`);
  }
  if (!stat.isDirectory()) throw new HttpError(400, 'invalid_cwd', `cwd is not a directory: ${rawCwd}`);
  return target;
}

function validateCreateBody(body, config) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'invalid_request', 'Request body must be a JSON object');
  }
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) {
    throw new HttpError(400, 'invalid_request', 'Field "prompt" is required and must be a non-empty string');
  }
  if (body.prompt.length > MAX_PROMPT_CHARS) {
    throw new HttpError(400, 'invalid_request', `Field "prompt" exceeds ${MAX_PROMPT_CHARS} characters`);
  }

  const options = {};

  if (body.timeout_ms !== undefined) {
    if (!Number.isInteger(body.timeout_ms) || body.timeout_ms < 1000 || body.timeout_ms > config.maxTaskTimeoutMs) {
      throw new HttpError(
        400,
        'invalid_request',
        `Field "timeout_ms" must be an integer between 1000 and ${config.maxTaskTimeoutMs}`,
      );
    }
    options.timeout_ms = body.timeout_ms;
  }

  if (body.model !== undefined) {
    if (typeof body.model !== 'string' || !body.model.trim() || body.model.length > 120 || /[\s\u0000-\u001f]/.test(body.model)) {
      throw new HttpError(400, 'invalid_request', 'Field "model" must be a non-empty string without whitespace (max 120 chars)');
    }
    options.model = body.model.trim();
  }

  if (body.permission_mode !== undefined) {
    if (!PERMISSION_MODES.includes(body.permission_mode)) {
      throw new HttpError(
        400,
        'invalid_request',
        `Field "permission_mode" must be one of: ${PERMISSION_MODES.join(', ')}`,
      );
    }
    options.permission_mode = body.permission_mode;
  }

  if (body.max_budget_usd !== undefined) {
    const value = body.max_budget_usd;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 10_000) {
      throw new HttpError(400, 'invalid_request', 'Field "max_budget_usd" must be a positive number (max 10000)');
    }
    options.max_budget_usd = value;
  }

  if (body.system_prompt !== undefined) {
    if (typeof body.system_prompt !== 'string' || body.system_prompt.length > MAX_SYSTEM_PROMPT_CHARS) {
      throw new HttpError(400, 'invalid_request', `Field "system_prompt" must be a string (max ${MAX_SYSTEM_PROMPT_CHARS} chars)`);
    }
    if (body.system_prompt.trim()) options.system_prompt = body.system_prompt;
  }

  for (const field of ['allowed_tools', 'disallowed_tools']) {
    if (body[field] === undefined) continue;
    const value = body[field];
    if (!Array.isArray(value) || value.length > 200 || value.some((item) => typeof item !== 'string' || item.length > 300)) {
      throw new HttpError(400, 'invalid_request', `Field "${field}" must be an array of up to 200 strings`);
    }
    if (value.length > 0) options[field] = value;
  }

  return {
    prompt: body.prompt,
    options,
    cwd: resolveCwd(body.cwd, config),
  };
}

function sseHeaders(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
}

export function createApp({ config, logger, manager, claudeCheck }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: config.bodyLimit }));

  app.use((req, res, next) => {
    const startedAt = Date.now();
    res.on('finish', () => {
      if (req.path.startsWith('/healthz') || req.path.startsWith('/readyz')) return;
      logger.debug('request completed', {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration_ms: Date.now() - startedAt,
      });
    });
    next();
  });

  app.use('/v1', (req, res, next) => {
    if (!config.serviceApiKey) return next();
    if (!bearerMatches(req.get('authorization'), config.serviceApiKey)) {
      return next(new HttpError(401, 'unauthorized', 'Missing or invalid Authorization bearer token'));
    }
    return next();
  });

  app.get('/healthz', (req, res) => {
    res.json({ status: 'ok', service: 'claude-code-agent-api', pid: process.pid, uptime_s: manager.stats().uptime_s });
  });

  app.get('/readyz', (req, res) => {
    const credentials = describeCredentials(config);
    const binary = claudeCheck ?? { ok: false, version: null, error: 'claude binary check did not run' };
    const ready = credentials.ok && binary.ok;
    res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'not_ready',
      ready,
      checks: { claude_binary: binary, credentials },
      limits: {
        max_concurrent_tasks: config.maxConcurrentTasks,
        max_queue_size: config.maxQueueSize,
        default_task_timeout_ms: config.defaultTaskTimeoutMs,
        max_task_timeout_ms: config.maxTaskTimeoutMs,
      },
    });
  });

  app.get('/v1/info', (req, res) => {
    const credentials = describeCredentials(config);
    res.json({
      service: 'claude-code-agent-api',
      stats: manager.stats(),
      claude: { binary: claudeCheck ?? null, permission_mode: config.permissionMode, model: config.defaultModel || null },
      credentials: { ok: credentials.ok, source: credentials.source },
      workspace_dir: config.workspaceDir,
    });
  });

  app.post('/v1/tasks', (req, res) => {
    const { prompt, options, cwd } = validateCreateBody(req.body, config);
    const task = manager.createTask({ prompt, cwd, options });
    logger.info('task accepted', { task_id: task.id, cwd, timeout_ms: options.timeout_ms ?? config.defaultTaskTimeoutMs });
    res.status(202).json({
      task_id: task.id,
      status: task.status,
      queue_position: manager.snapshot(task).queue_position,
      status_url: `/v1/tasks/${task.id}`,
      stream_url: `/v1/tasks/${task.id}/stream`,
    });
  });

  app.get('/v1/tasks', (req, res) => {
    const limit = Math.min(Math.max(parseSeq(req.query.limit, 50), 1), 200);
    res.json({ tasks: manager.listTasks({ limit }).map((task) => manager.snapshot(task)), stats: manager.stats() });
  });

  app.get('/v1/tasks/:id', (req, res, next) => {
    const task = manager.getTask(req.params.id);
    if (!task) return next(new HttpError(404, 'task_not_found', `Task ${req.params.id} does not exist`));
    const includeEvents = String(req.query.include_events ?? '') === '1';
    const snapshot = manager.snapshot(task);
    if (includeEvents) {
      const fromSeq = parseSeq(req.query.from_seq ?? req.get('last-event-id'), 0);
      snapshot.events = manager.getEventsFrom(task, fromSeq);
    }
    res.json(snapshot);
  });

  app.post('/v1/tasks/:id/cancel', (req, res, next) => {
    const result = manager.cancelTask(req.params.id);
    res.status(202).json(result);
  });

  app.get('/v1/tasks/:id/stream', (req, res, next) => {
    const task = manager.getTask(req.params.id);
    if (!task) return next(new HttpError(404, 'task_not_found', `Task ${req.params.id} does not exist`));

    const fromSeq = parseSeq(req.query.from_seq ?? req.query.from ?? req.get('last-event-id'), 0);
    const cancelOnDisconnect = ['1', 'true', 'yes'].includes(String(req.query.cancel_on_disconnect ?? '').toLowerCase());

    sseHeaders(res);

    let closed = false;
    let heartbeat = null;
    let unsubscribe = null;

    const cleanup = () => {
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      unsubscribe?.();
      unsubscribe = null;
      if (cancelOnDisconnect && !TERMINAL_STATUSES.has(task.status)) {
        try {
          manager.cancelTask(task.id);
        } catch (error) {
          logger.warn('cancel_on_disconnect failed', { task_id: task.id, error: error.message });
        }
      }
    };

    const finish = () => {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe?.();
      if (!res.writableEnded) {
        try {
          res.write(`event: end\ndata: ${JSON.stringify({ task_id: task.id, status: task.status })}\n\n`);
        } catch {
          // client already gone
        }
        res.end();
      }
    };

    const writeRecord = (record) => {
      if (closed || res.writableEnded) return;
      res.write(`id: ${record.seq}\nevent: ${record.event}\ndata: ${JSON.stringify(record.data)}\n\n`);
      if (record.event === 'status' && TERMINAL_STATUSES.has(record.data.status)) finish();
    };

    for (const record of manager.getEventsFrom(task, fromSeq)) writeRecord(record);
    if (closed) return;

    if (TERMINAL_STATUSES.has(task.status)) {
      finish();
      return;
    }

    unsubscribe = manager.subscribe(task, writeRecord);
    heartbeat = setInterval(() => {
      if (!closed && !res.writableEnded) res.write(': ping\n\n');
    }, config.sseHeartbeatMs);

    req.on('close', () => {
      if (closed) return;
      closed = true;
      cleanup();
    });
  });

  app.use((req, res, next) => {
    next(new HttpError(404, 'not_found', `No route for ${req.method} ${req.path}`));
  });

  app.use((error, req, res, next) => { // eslint-disable-line no-unused-vars
    if (res.headersSent) {
      logger.error('error after headers sent', { path: req.path, error: error.message });
      return res.end();
    }

    if (error instanceof HttpError) {
      return res.status(error.status).json({
        error: { code: error.code, message: error.message, details: error.details ?? null },
      });
    }

    if (error?.type === 'entity.parse.failed' || error instanceof SyntaxError) {
      return res.status(400).json({
        error: { code: 'invalid_json', message: 'Request body is not valid JSON', details: null },
      });
    }
    if (error?.type === 'entity.too.large') {
      return res.status(413).json({
        error: { code: 'payload_too_large', message: `Request body exceeds ${config.bodyLimit}`, details: null },
      });
    }

    logger.error('unhandled request error', { path: req.path, error: error.message, stack: error.stack });
    return res.status(500).json({
      error: { code: 'internal_error', message: 'Internal server error', details: null },
    });
  });

  return app;
}
