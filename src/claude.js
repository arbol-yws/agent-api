import { spawn } from 'node:child_process';
import { mapResultError, normalizeCliEvent, truncateText } from './normalize.js';

const MAX_STDOUT_LINE_BYTES = 10 * 1024 * 1024;
const MAX_STDERR_TAIL_BYTES = 8 * 1024;
const ANSI_ESCAPE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export function buildArgs({ options = {}, config }) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence'];

  if (config.includePartialMessages) args.push('--include-partial-messages');
  if (config.bare) args.push('--bare');

  args.push('--permission-mode', options.permission_mode || config.permissionMode);

  const model = options.model || config.defaultModel;
  if (model) args.push('--model', model);

  if (options.max_budget_usd !== undefined && options.max_budget_usd !== null) {
    args.push('--max-budget-usd', String(options.max_budget_usd));
  }
  if (typeof options.system_prompt === 'string' && options.system_prompt.trim()) {
    args.push('--system-prompt', options.system_prompt);
  }
  if (Array.isArray(options.allowed_tools) && options.allowed_tools.length > 0) {
    args.push('--allowedTools', options.allowed_tools.join(','));
  }
  if (Array.isArray(options.disallowed_tools) && options.disallowed_tools.length > 0) {
    args.push('--disallowedTools', options.disallowed_tools.join(','));
  }

  args.push(...config.extraArgs);
  return args;
}

export function buildChildEnv({ config, options = {} }) {
  const source = config.runtimeEnv ?? process.env;
  const env = {};
  for (const key of config.envPassthrough) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }

  // These are required for the CLI and its shell tools to work regardless of
  // what the operator configured in CLAUDE_ENV_PASSTHROUGH.
  env.PATH = source.PATH ?? '/usr/local/bin:/usr/bin:/bin';
  env.HOME = config.claudeHome;
  env.TERM = 'dumb';
  env.NO_COLOR = '1';
  env.FORCE_COLOR = '0';

  if (options.model) env.ANTHROPIC_MODEL = options.model;
  return env;
}

export function checkClaudeBinary({ config, timeoutMs = 10_000 }) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    let child;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    try {
      child = spawn(config.claudeBin, ['--version'], {
        env: buildChildEnv({ config }),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish({ ok: false, version: null, error: error.message });
      return;
    }

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      finish({ ok: false, version: null, error: error.message });
    });
    child.on('close', (code) => {
      const version = stdout.trim().split('\n')[0] || null;
      if (code === 0) finish({ ok: true, version, error: null });
      else finish({ ok: false, version, error: `claude --version exited with code ${code}: ${stderr.trim().slice(0, 300)}` });
    });
    timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      finish({ ok: false, version: null, error: `claude --version timed out after ${timeoutMs} ms` });
    }, timeoutMs);
  });
}

/**
 * Runs a real Claude Code headless process and streams its NDJSON events.
 *
 * Resolves with an outcome object; it never rejects for task-level failures so
 * the task manager can apply explicit error semantics.
 */
export function executeClaudeTask({
  prompt,
  cwd,
  options = {},
  timeoutMs,
  signal,
  config,
  logger,
  onProcessEvent = () => {},
}) {
  const args = buildArgs({ options, config });
  logger?.debug('spawning claude', { bin: config.claudeBin, args: args.filter((a) => !a.startsWith('sk-')) });

  return new Promise((resolve) => {
    let child = null;
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let killTimer = null;
    let timeoutTimer = null;
    let stdoutBuffer = '';
    let stderrTail = '';
    let resultEvent = null;
    let lastCliError = null;
    let droppedLines = 0;
    let exitCode = null;
    let exitSignal = null;

    const killGroup = (signalName) => {
      if (!child || child.pid === undefined) return;
      try {
        process.kill(-child.pid, signalName);
      } catch {
        try {
          child.kill(signalName);
        } catch {
          // process already gone
        }
      }
    };

    const escalateKill = () => {
      killGroup('SIGTERM');
      killTimer = setTimeout(() => killGroup('SIGKILL'), config.killGraceMs);
    };

    const finish = (extra = {}) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);

      let error = null;
      if (cancelled) {
        error = { code: 'cancelled', message: 'Task was cancelled' };
      } else if (timedOut) {
        error = {
          code: 'timeout',
          message: `Task exceeded its timeout of ${timeoutMs} ms and was terminated`,
          details: { timeout_ms: timeoutMs },
        };
      } else if (!resultEvent) {
        const stderrText = stderrTail.trim();
        error = {
          code: exitCode === 0 ? 'claude_no_result' : 'claude_exit_nonzero',
          message:
            exitCode === 0
              ? 'Claude Code exited without emitting a result event'
              : `Claude Code exited with code ${exitCode} before emitting a result event`,
          details: { exit_code: exitCode, signal: exitSignal, stderr_tail: stderrText || undefined },
        };
      } else if (resultEvent.is_error) {
        const mapped = mapResultError(resultEvent);
        if (lastCliError?.message && (!mapped.message || mapped.message === 'Claude Code returned an error result')) {
          mapped.message = lastCliError.message;
          mapped.details = { ...(mapped.details ?? {}), cli_error_code: lastCliError.code };
        }
        error = mapped;
      }

      const outcome = {
        result: resultEvent,
        exit_code: exitCode,
        exit_signal: exitSignal,
        stderr_tail: stderrTail.trim() || null,
        timed_out: timedOut,
        cancelled,
        dropped_lines: droppedLines,
        error,
        ...extra,
      };
      logger?.debug('claude finished', {
        exit_code: exitCode,
        is_error: Boolean(resultEvent?.is_error),
        timed_out: timedOut,
        cancelled,
        error_code: error?.code ?? null,
      });
      resolve(outcome);
    };

    if (signal?.aborted) {
      cancelled = true;
      resolve({
        result: null,
        exit_code: null,
        exit_signal: null,
        stderr_tail: null,
        timed_out: false,
        cancelled: true,
        dropped_lines: 0,
        error: { code: 'cancelled', message: 'Task was cancelled before start' },
      });
      return;
    }

    function onAbort() {
      cancelled = true;
      escalateKill();
    }

    try {
      child = spawn(config.claudeBin, args, {
        cwd,
        env: buildChildEnv({ config, options }),
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish({
        exit_code: null,
        exit_signal: null,
        error: { code: 'claude_spawn_failed', message: `Failed to spawn Claude Code: ${error.message}` },
        result: null,
      });
      return;
    }

    signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (error) => {
      if (settled) return;
      const code = error?.code === 'ENOENT' ? 'claude_binary_not_found' : 'claude_spawn_failed';
      finish({
        exit_code: null,
        exit_signal: null,
        result: null,
        error: { code, message: `Failed to start Claude Code (${config.claudeBin}): ${error.message}` },
      });
    });

    child.stdin.on('error', () => {
      // EPIPE when the CLI exits early; the close handler reports the real cause.
    });
    child.stdin.end(`${prompt}\n`);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk;
      if (stdoutBuffer.length > MAX_STDOUT_LINE_BYTES && !stdoutBuffer.includes('\n')) {
        droppedLines += 1;
        stdoutBuffer = '';
        onProcessEvent({
          kind: 'stdout_unparsed',
          message: 'Dropped an oversized output line from Claude Code',
          truncated: true,
        });
        return;
      }

      let newlineIndex = stdoutBuffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (line) handleLine(line);
        newlineIndex = stdoutBuffer.indexOf('\n');
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      const text = chunk.replace(ANSI_ESCAPE, '');
      stderrTail = (stderrTail + text).slice(-MAX_STDERR_TAIL_BYTES);
      for (const rawLine of text.split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;
        onProcessEvent({ kind: 'stderr', text: truncateText(line).text });
      }
    });

    child.on('close', (code, signalName) => {
      exitCode = code;
      exitSignal = signalName;
      if (stdoutBuffer.trim()) handleLine(stdoutBuffer.trim());
      stdoutBuffer = '';
      finish();
    });

    timeoutTimer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      onProcessEvent({ kind: 'notice', code: 'timeout', message: `Task timeout of ${timeoutMs} ms reached` });
      escalateKill();
    }, timeoutMs);

    function handleLine(line) {
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        droppedLines += 1;
        onProcessEvent({
          kind: 'stdout_unparsed',
          text: truncateText(line, 2000).text,
          message: 'Claude Code emitted a non-JSON line',
        });
        return;
      }

      if (parsed && parsed.type === 'result') {
        // Store the normalized shape so downstream error mapping and result
        // reporting see a stable schema (`text` instead of raw `result`).
        resultEvent = normalizeCliEvent(parsed)[0];
        return;
      }

      for (const event of normalizeCliEvent(parsed)) {
        if (event.kind === 'cli_error') lastCliError = event;
        onProcessEvent(event);
      }
    }
  });
}
