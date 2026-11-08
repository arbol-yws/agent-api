import fs from 'node:fs';
import path from 'node:path';

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

const CREDENTIAL_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AWS_PROFILE',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'CLOUD_ML_REGION',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
];

const DEFAULT_PASSTHROUGH = [
  'PATH',
  'LANG',
  'LC_ALL',
  'TZ',
  'TMPDIR',
  'SHELL',
  ...CREDENTIAL_ENV_KEYS,
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'CLAUDE_CODE_TMPDIR',
  'CLAUDE_CODE_EXTRA_BODY',
  'CLAUDE_CONFIG_DIR',
];

const CREDENTIAL_SETUP_HINT =
  'ANTHROPIC_API_KEY, or ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL, or CLAUDE_CODE_USE_BEDROCK=1, or CLAUDE_CODE_USE_VERTEX=1';

/**
 * 仅当显式设置 ENV_FILE 时才读取指定文件，且不会覆盖已存在的环境变量。
 * 服务运行不依赖 .env；未设置 ENV_FILE 时这里什么都不做。
 */
export function loadEnvFile(filePath, env = process.env) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new ConfigError(`ENV_FILE ${filePath} could not be read: ${error.message}`);
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' || first === "'") && last === first) value = value.slice(1, -1);
    }
    if (env[match[1]] === undefined) env[match[1]] = value;
  }
  return env;
}

/** 返回缺失的必需变量名；凭据有多种互斥的提供方式，只要求满足其中一种。 */
export function collectMissingConfig(config) {
  if (config.auth.apiKey) return [];
  if (config.auth.useBedrock || config.auth.useVertex) return [];
  if (config.auth.authToken) return config.auth.baseUrl ? [] : ['ANTHROPIC_BASE_URL'];
  return ['ANTHROPIC_API_KEY'];
}

function readString(env, name, fallback = '') {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  return String(raw);
}

function readInt(env, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new ConfigError(`${name} must be an integer, got "${raw}"`);
  if (value < min || value > max) throw new ConfigError(`${name} must be between ${min} and ${max}, got ${value}`);
  return value;
}

function readBool(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new ConfigError(`${name} must be a boolean, got "${raw}"`);
}

function readList(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  return String(raw)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function readArgs(env, name) {
  const raw = env[name];
  if (raw === undefined || raw === '') return [];
  return String(raw)
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function loadConfig(env = process.env) {
  // 可选：仅在显式指定 ENV_FILE 时加载本文件，作为本地开发的便利，不作为运行前提。
  if (env.ENV_FILE) loadEnvFile(env.ENV_FILE, env);

  const workspaceDir = path.resolve(readString(env, 'WORKSPACE_DIR', '/workspace'));
  const claudeBin = readString(env, 'CLAUDE_BIN', 'claude');
  const permissionMode = readString(env, 'CLAUDE_PERMISSION_MODE', 'bypassPermissions');
  const allowedPermissionModes = ['default', 'acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'];
  if (!allowedPermissionModes.includes(permissionMode)) {
    throw new ConfigError(
      `CLAUDE_PERMISSION_MODE must be one of ${allowedPermissionModes.join(', ')}, got "${permissionMode}"`,
    );
  }

  const maxTaskTimeoutMs = readInt(env, 'MAX_TASK_TIMEOUT_MS', 3_600_000, { min: 1000 });
  const defaultTaskTimeoutMs = readInt(env, 'TASK_TIMEOUT_MS', 600_000, { min: 1000 });
  if (defaultTaskTimeoutMs > maxTaskTimeoutMs) {
    throw new ConfigError('TASK_TIMEOUT_MS cannot be greater than MAX_TASK_TIMEOUT_MS');
  }

  const config = {
    runtimeEnv: env,
    port: readInt(env, 'PORT', 8080, { min: 0, max: 65535 }),
    host: readString(env, 'HOST', '0.0.0.0'),
    logLevel: readString(env, 'LOG_LEVEL', 'info'),
    bodyLimit: readString(env, 'BODY_LIMIT', '512kb'),

    serviceApiKey: readString(env, 'SERVICE_API_KEY', ''),

    claudeBin,
    workspaceDir,
    stateDir: path.resolve(readString(env, 'STATE_DIR', './state')),
    claudeHome: path.resolve(readString(env, 'CLAUDE_HOME', env.HOME || '/home/agent')),
    defaultModel: readString(env, 'CLAUDE_MODEL', ''),
    permissionMode,
    bare: readBool(env, 'CLAUDE_BARE', false),
    includePartialMessages: readBool(env, 'CLAUDE_INCLUDE_PARTIAL_MESSAGES', true),
    extraArgs: readArgs(env, 'CLAUDE_EXTRA_ARGS'),
    envPassthrough: readList(env, 'CLAUDE_ENV_PASSTHROUGH', DEFAULT_PASSTHROUGH),
    killGraceMs: readInt(env, 'CLAUDE_KILL_GRACE_MS', 5000, { min: 100, max: 60_000 }),
    startupCheck: readBool(env, 'CLAUDE_STARTUP_CHECK', true),

    maxConcurrentTasks: readInt(env, 'MAX_CONCURRENT_TASKS', 2, { min: 1, max: 64 }),
    maxQueueSize: readInt(env, 'MAX_QUEUE_SIZE', 32, { min: 0, max: 4096 }),
    defaultTaskTimeoutMs,
    maxTaskTimeoutMs,
    maxEventsPerTask: readInt(env, 'MAX_EVENTS_PER_TASK', 5000, { min: 50, max: 200_000 }),
    taskTtlMs: readInt(env, 'TASK_TTL_MS', 0, { min: 0 }),

    sseHeartbeatMs: readInt(env, 'SSE_HEARTBEAT_MS', 15_000, { min: 1000, max: 120_000 }),
    sseMaxBufferBytes: readInt(env, 'SSE_MAX_BUFFER_BYTES', 8 * 1024 * 1024, { min: 64 * 1024 }),

    auth: {
      apiKey: readString(env, 'ANTHROPIC_API_KEY', ''),
      authToken: readString(env, 'ANTHROPIC_AUTH_TOKEN', ''),
      baseUrl: readString(env, 'ANTHROPIC_BASE_URL', ''),
      useBedrock: readString(env, 'CLAUDE_CODE_USE_BEDROCK', '') === '1',
      useVertex: readString(env, 'CLAUDE_CODE_USE_VERTEX', '') === '1',
    },
  };

  const missing = collectMissingConfig(config);
  if (missing.length > 0) {
    const error = new ConfigError(
      `Missing required environment variable(s): ${missing.join(', ')}. ` +
        `Provide credentials via one of: ${CREDENTIAL_SETUP_HINT}. ` +
        'Configuration is read from the process environment only (an optional ENV_FILE can be set explicitly).',
    );
    error.missing = missing;
    throw error;
  }

  return config;
}

export function describeCredentials(config) {
  if (config.auth.apiKey) return { ok: true, source: 'ANTHROPIC_API_KEY' };
  if (config.auth.authToken && config.auth.baseUrl) {
    return { ok: true, source: 'ANTHROPIC_AUTH_TOKEN+ANTHROPIC_BASE_URL' };
  }
  if (config.auth.useBedrock) return { ok: true, source: 'CLAUDE_CODE_USE_BEDROCK' };
  if (config.auth.useVertex) return { ok: true, source: 'CLAUDE_CODE_USE_VERTEX' };
  if (config.auth.authToken) {
    return {
      ok: false,
      source: 'ANTHROPIC_AUTH_TOKEN',
      reason: 'ANTHROPIC_AUTH_TOKEN is set but ANTHROPIC_BASE_URL is missing',
    };
  }
  return {
    ok: false,
    source: null,
    reason: 'No credentials configured. Set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL).',
  };
}
