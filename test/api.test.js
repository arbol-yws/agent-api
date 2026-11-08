import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { startServer } from '../src/server.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);

function makeRuntime(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-agent-api-test-'));
  const workspaceDir = path.join(root, 'workspace');
  const claudeHome = path.join(root, 'home');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(claudeHome, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  const env = {
    ...process.env,
    PORT: '0',
    HOST: '127.0.0.1',
    LOG_LEVEL: 'error',
    WORKSPACE_DIR: workspaceDir,
    STATE_DIR: stateDir,
    CLAUDE_HOME: claudeHome,
    ANTHROPIC_API_KEY: 'sk-ant-api03-invalid-integration-test-key',
    TASK_TIMEOUT_MS: '30000',
    MAX_CONCURRENT_TASKS: '2',
    MAX_QUEUE_SIZE: '4',
    SSE_HEARTBEAT_MS: '2000',
    ...overrides,
  };

  return { env, root, stateDir };
}

async function bootFromRuntime(runtime) {
  const instance = await startServer({ env: runtime.env });
  const address = instance.server.address();
  return {
    ...instance,
    root: runtime.root,
    stateDir: runtime.stateDir,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function boot(overrides) {
  const runtime = makeRuntime(overrides);
  return bootFromRuntime(runtime);
}

async function stop(booted, { removeRoot = true } = {}) {
  await booted.manager.shutdown(5000);
  booted.server.closeAllConnections?.();
  await new Promise((resolve) => booted.server.close(resolve));
  if (removeRoot) fs.rmSync(booted.root, { recursive: true, force: true });
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  return { status: response.status, body, headers: response.headers };
}

function parseSseBlock(block) {
  const lines = block.split('\n');
  const event = { id: null, event: 'message', data: null };
  for (const line of lines) {
    if (line.startsWith(':')) continue;
    const index = line.indexOf(':');
    if (index === -1) continue;
    const field = line.slice(0, index);
    const value = line.slice(index + 1).replace(/^ /, '');
    if (field === 'event') event.event = value;
    else if (field === 'id') event.id = Number(value);
    else if (field === 'data') event.data = JSON.parse(value);
  }
  return event;
}

async function collectSse(url, headers = {}) {
  const response = await fetch(url, {
    headers: { accept: 'text/event-stream', ...headers },
    signal: AbortSignal.timeout(60_000),
  });
  assert.equal(response.status, 200, 'SSE endpoint should return 200');
  assert.match(response.headers.get('content-type'), /text\/event-stream/);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      if (block.trim()) events.push(parseSseBlock(block));
      boundary = buffer.indexOf('\n\n');
    }
  }
  return events;
}

async function waitForTerminal(baseUrl, taskId, { timeoutMs = 60_000, headers = {} } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { body } = await jsonRequest(`${baseUrl}/v1/tasks/${taskId}`, { headers });
    if (TERMINAL.has(body.status)) return body;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Task ${taskId} did not reach a terminal state within ${timeoutMs} ms`);
}

async function createTask(baseUrl, payload, headers = {}) {
  return jsonRequest(`${baseUrl}/v1/tasks`, {
    method: 'POST',
    body: JSON.stringify(payload),
    headers,
  });
}

describe('claude code agent api', () => {
  let api;
  let finishedTaskId = null;

  before(async () => {
    api = await boot();
  });

  after(async () => {
    await stop(api);
  });

  it('serves liveness and readiness with a real claude binary', async () => {
    const health = await jsonRequest(`${api.baseUrl}/healthz`);
    assert.equal(health.status, 200);
    assert.equal(health.body.status, 'ok');

    const ready = await jsonRequest(`${api.baseUrl}/readyz`);
    assert.equal(ready.status, 200, JSON.stringify(ready.body));
    assert.equal(ready.body.ready, true);
    assert.equal(ready.body.checks.claude_binary.ok, true);
    assert.equal(ready.body.checks.credentials.ok, true);
    assert.match(ready.body.checks.claude_binary.version ?? '', /Claude Code/);
  });

  it('rejects invalid task payloads with explicit error codes', async () => {
    const empty = await createTask(api.baseUrl, { prompt: '   ' });
    assert.equal(empty.status, 400);
    assert.equal(empty.body.error.code, 'invalid_request');

    const badTimeout = await createTask(api.baseUrl, { prompt: 'hi', timeout_ms: 999 });
    assert.equal(badTimeout.status, 400);
    assert.equal(badTimeout.body.error.code, 'invalid_request');

    const escapingCwd = await createTask(api.baseUrl, { prompt: 'hi', cwd: '../outside' });
    assert.equal(escapingCwd.status, 400);
    assert.equal(escapingCwd.body.error.code, 'invalid_cwd');

    const missingCwd = await createTask(api.baseUrl, { prompt: 'hi', cwd: 'does-not-exist' });
    assert.equal(missingCwd.status, 400);
    assert.equal(missingCwd.body.error.code, 'invalid_cwd');

    const notFound = await jsonRequest(`${api.baseUrl}/v1/nope`);
    assert.equal(notFound.status, 404);
    assert.equal(notFound.body.error.code, 'not_found');
  });

  it('streams real claude process events, an error, and a terminal status', async () => {
    const created = await createTask(api.baseUrl, { prompt: 'Reply with the single word ping', timeout_ms: 30_000 });
    assert.equal(created.status, 202);
    assert.match(created.body.task_id, /^tsk_/);
    const taskId = created.body.task_id;

    const events = await collectSse(`${api.baseUrl}/v1/tasks/${taskId}/stream`);
    const names = events.map((event) => event.event);
    assert.deepEqual(names.slice(0, 2), ['status', 'status'], 'queued then running status should be replayed');
    assert.ok(names.includes('process'), 'process events must be streamed');
    assert.ok(names.includes('error'), 'failed authentication must produce an error event');
    assert.equal(names.at(-1), 'end', 'stream must terminate with an end event');

    const processEvent = events.find((event) => event.event === 'process');
    assert.equal(processEvent.data.kind, 'system');
    assert.equal(processEvent.data.subtype, 'init');
    assert.equal(processEvent.data.claude_code_version.length > 0, true);

    const errorEvent = events.find((event) => event.event === 'error');
    assert.equal(errorEvent.data.code, 'claude_auth_failed');
    assert.match(errorEvent.data.message, /authenticate|api key|403/i);

    const statusEvent = events.at(-2);
    assert.equal(statusEvent.event, 'status');
    assert.equal(statusEvent.data.status, 'failed');

    const task = await waitForTerminal(api.baseUrl, taskId);
    assert.equal(task.status, 'failed');
    assert.equal(task.error.code, 'claude_auth_failed');
    assert.equal(task.events_truncated, false);
    finishedTaskId = taskId;
  });

  it('replays buffered events after a reconnect using from_seq', async () => {
    const events = await collectSse(`${api.baseUrl}/v1/tasks/${finishedTaskId}/stream?from_seq=5`);
    assert.ok(events.length > 0);
    assert.ok(events.every((event) => event.id === null || event.id > 5), 'replay must skip events at or below from_seq');
    assert.equal(events.at(-1).event, 'end');

    const detail = await jsonRequest(`${api.baseUrl}/v1/tasks/${finishedTaskId}?include_events=1&from_seq=5`);
    assert.equal(detail.status, 200);
    assert.ok(detail.body.events.length > 0);
    assert.ok(detail.body.events.every((record) => record.seq > 5));
  });

  it('runs concurrent tasks and queues beyond the concurrency limit', async () => {
    const first = await createTask(api.baseUrl, { prompt: 'one', timeout_ms: 30_000 });
    const second = await createTask(api.baseUrl, { prompt: 'two', timeout_ms: 30_000 });
    const third = await createTask(api.baseUrl, { prompt: 'three', timeout_ms: 30_000 });
    assert.equal(first.status, 202);
    assert.equal(second.status, 202);
    assert.equal(third.status, 202);
    assert.equal(third.body.status, 'queued', 'third task should wait because MAX_CONCURRENT_TASKS=2');

    const [a, b, c] = await Promise.all([
      waitForTerminal(api.baseUrl, first.body.task_id),
      waitForTerminal(api.baseUrl, second.body.task_id),
      waitForTerminal(api.baseUrl, third.body.task_id),
    ]);
    for (const task of [a, b, c]) {
      assert.equal(task.status, 'failed');
      assert.equal(task.error.code, 'claude_auth_failed');
    }

    const info = await jsonRequest(`${api.baseUrl}/v1/info`);
    assert.equal(info.body.stats.running, 0);
    assert.equal(info.body.stats.queued, 0);
  });

  it('cancels a running task with cancelled semantics', async () => {
    const created = await createTask(api.baseUrl, { prompt: 'slow task', timeout_ms: 60_000 });
    const taskId = created.body.task_id;
    await new Promise((resolve) => setTimeout(resolve, 400));

    const cancelled = await jsonRequest(`${api.baseUrl}/v1/tasks/${taskId}/cancel`, { method: 'POST' });
    assert.equal(cancelled.status, 202);
    assert.equal(cancelled.body.accepted, true);

    const task = await waitForTerminal(api.baseUrl, taskId);
    assert.equal(task.status, 'cancelled');
    assert.equal(task.error.code, 'cancelled');

    const again = await jsonRequest(`${api.baseUrl}/v1/tasks/${taskId}/cancel`, { method: 'POST' });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'task_already_terminal');
  });
});

describe('timeouts, queue limits and service auth', () => {
  let api;

  before(async () => {
    api = await boot({
      TASK_TIMEOUT_MS: '1500',
      MAX_CONCURRENT_TASKS: '1',
      MAX_QUEUE_SIZE: '1',
      SERVICE_API_KEY: 'test-service-secret',
    });
  });

  after(async () => {
    await stop(api);
  });

  it('requires a bearer token for /v1 when SERVICE_API_KEY is set', async () => {
    const unauthorized = await jsonRequest(`${api.baseUrl}/v1/info`);
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.body.error.code, 'unauthorized');

    const wrong = await jsonRequest(`${api.baseUrl}/v1/info`, { headers: { authorization: 'Bearer nope' } });
    assert.equal(wrong.status, 401);

    const ok = await jsonRequest(`${api.baseUrl}/v1/info`, {
      headers: { authorization: 'Bearer test-service-secret' },
    });
    assert.equal(ok.status, 200);

    const health = await jsonRequest(`${api.baseUrl}/healthz`);
    assert.equal(health.status, 200, 'health checks must stay unauthenticated');
  });

  it('terminates a task that exceeds its timeout', async () => {
    const headers = { authorization: 'Bearer test-service-secret' };
    const created = await createTask(api.baseUrl, { prompt: 'timeout probe', timeout_ms: 1500 }, headers);
    assert.equal(created.status, 202);

    const task = await waitForTerminal(api.baseUrl, created.body.task_id, { headers });
    assert.equal(task.status, 'timed_out');
    assert.equal(task.error.code, 'timeout');
    assert.equal(task.error.details.timeout_ms, 1500);
  });

  it('rejects new tasks with queue_full when the queue is saturated', async () => {
    const headers = { authorization: 'Bearer test-service-secret' };
    const first = await createTask(api.baseUrl, { prompt: 'holds the worker', timeout_ms: 60_000 }, headers);
    assert.equal(first.status, 202);

    const second = await createTask(api.baseUrl, { prompt: 'waits in queue', timeout_ms: 60_000 }, headers);
    assert.equal(second.status, 202);
    assert.equal(second.body.status, 'queued');

    const third = await createTask(api.baseUrl, { prompt: 'should be rejected', timeout_ms: 60_000 }, headers);
    assert.equal(third.status, 429);
    assert.equal(third.body.error.code, 'queue_full');

    await jsonRequest(`${api.baseUrl}/v1/tasks/${first.body.task_id}/cancel`, { method: 'POST', headers });
    await jsonRequest(`${api.baseUrl}/v1/tasks/${second.body.task_id}/cancel`, { method: 'POST', headers });
    await waitForTerminal(api.baseUrl, first.body.task_id, { headers });
    await waitForTerminal(api.baseUrl, second.body.task_id, { headers });
  });
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getFreePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function waitForHealth(baseUrl, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
    } catch {
      // server not accepting yet
    }
    await sleep(250);
  }
  throw new Error('Server did not become healthy in time');
}

describe('file persistence', () => {
  it('restores a finished task and its events after a restart', async () => {
    const runtime = makeRuntime();
    let api = await bootFromRuntime(runtime);
    try {
      const created = await createTask(api.baseUrl, { prompt: 'persist me' });
      const before = await waitForTerminal(api.baseUrl, created.body.task_id);
      assert.equal(before.status, 'failed');

      const taskDir = path.join(runtime.stateDir, 'tasks', created.body.task_id);
      assert.ok(fs.existsSync(path.join(taskDir, 'meta.json')), 'meta.json should exist on disk');
      assert.ok(fs.existsSync(path.join(taskDir, 'events.jsonl')), 'events.jsonl should exist on disk');

      await stop(api, { removeRoot: false });
      api = null;
      api = await bootFromRuntime(runtime);

      const afterRestart = await jsonRequest(`${api.baseUrl}/v1/tasks/${created.body.task_id}`);
      assert.equal(afterRestart.status, 200);
      assert.equal(afterRestart.body.status, 'failed');
      assert.equal(afterRestart.body.error.code, 'claude_auth_failed');
      assert.equal(afterRestart.body.events_buffered, before.events_buffered);
      assert.equal(afterRestart.body.events_truncated, false);

      const replay = await collectSse(`${api.baseUrl}/v1/tasks/${created.body.task_id}/stream`);
      assert.equal(replay[0].event, 'status');
      assert.equal(replay.at(-1).event, 'end');
      assert.ok(replay.some((event) => event.event === 'process'));
    } finally {
      if (api) await stop(api, { removeRoot: false });
      fs.rmSync(runtime.root, { recursive: true, force: true });
    }
  });

  it('marks tasks that were running at crash time as server_restarted', async () => {
    const runtime = makeRuntime();
    const port = await getFreePort();
    const child = spawn(process.execPath, ['src/server.js'], {
      cwd: PROJECT_ROOT,
      env: { ...runtime.env, PORT: String(port), STATE_DIR: runtime.stateDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let childStderr = '';
    child.stderr.on('data', (chunk) => {
      childStderr += chunk.toString();
    });
    const childExit = new Promise((resolve) => child.once('exit', resolve));

    const baseUrl = `http://127.0.0.1:${port}`;
    let api = null;
    try {
      await waitForHealth(baseUrl);
      const created = await createTask(baseUrl, { prompt: 'crash probe', timeout_ms: 30_000 });
      assert.equal(created.status, 202);

      const deadline = Date.now() + 15_000;
      let wasRunning = false;
      while (Date.now() < deadline) {
        const current = await jsonRequest(`${baseUrl}/v1/tasks/${created.body.task_id}`);
        if (current.body.status === 'running') {
          wasRunning = true;
          break;
        }
        await sleep(200);
      }
      assert.ok(wasRunning, 'task should be running before the crash');

      child.kill('SIGKILL');
      await childExit;

      api = await bootFromRuntime(runtime);
      const restored = await jsonRequest(`${api.baseUrl}/v1/tasks/${created.body.task_id}`);
      assert.equal(restored.status, 200);
      assert.equal(restored.body.status, 'failed');
      assert.equal(restored.body.error.code, 'server_restarted');
      assert.equal(restored.body.error.details.previous_status, 'running');

      const replay = await collectSse(`${api.baseUrl}/v1/tasks/${created.body.task_id}/stream`);
      const errorEvent = replay.find((event) => event.event === 'error');
      assert.equal(errorEvent.data.code, 'server_restarted');
      assert.equal(replay.at(-1).event, 'end');
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
      await Promise.race([childExit, sleep(5000)]);
      if (api) await stop(api);
      else fs.rmSync(runtime.root, { recursive: true, force: true });
    }
  });

  it('removes expired terminal tasks from memory and disk when TASK_TTL_MS is set', async () => {
    const runtime = makeRuntime({ TASK_TTL_MS: '1000' });
    const api = await bootFromRuntime(runtime);
    try {
      const created = await createTask(api.baseUrl, { prompt: 'ttl probe' });
      await waitForTerminal(api.baseUrl, created.body.task_id);

      const taskDir = path.join(runtime.stateDir, 'tasks', created.body.task_id);
      assert.ok(fs.existsSync(taskDir));

      const deadline = Date.now() + 20_000;
      let gone = false;
      while (Date.now() < deadline) {
        const current = await jsonRequest(`${api.baseUrl}/v1/tasks/${created.body.task_id}`);
        if (current.status === 404) {
          gone = true;
          break;
        }
        await sleep(500);
      }

      assert.ok(gone, 'expired task should disappear from the API');
      const final = await jsonRequest(`${api.baseUrl}/v1/tasks/${created.body.task_id}`);
      assert.equal(final.status, 404);
      assert.equal(final.body.error.code, 'task_not_found');
      assert.equal(fs.existsSync(taskDir), false, 'task directory should be deleted from disk');
    } finally {
      await stop(api);
    }
  });
});
