import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { ConfigError, loadConfig, collectMissingConfig } from '../src/config.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function cleanEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'ENV_FILE',
  ]) {
    delete env[key];
  }
  return { ...env, ...overrides };
}

describe('configuration is env-only and fails fast', { concurrency: false }, () => {
  it('throws a ConfigError listing the missing credential variable', () => {
    assert.throws(
      () => loadConfig(cleanEnv()),
      (error) => {
        assert.ok(error instanceof ConfigError);
        assert.deepEqual(error.missing, ['ANTHROPIC_API_KEY']);
        assert.match(error.message, /Missing required environment variable\(s\): ANTHROPIC_API_KEY/);
        return true;
      },
    );
  });

  it('requires ANTHROPIC_BASE_URL when only ANTHROPIC_AUTH_TOKEN is provided', () => {
    assert.throws(
      () => loadConfig(cleanEnv({ ANTHROPIC_AUTH_TOKEN: 'token' })),
      (error) => {
        assert.deepEqual(error.missing, ['ANTHROPIC_BASE_URL']);
        assert.match(error.message, /ANTHROPIC_BASE_URL/);
        return true;
      },
    );
  });

  it('accepts gateway credentials, Bedrock or Vertex without an API key', () => {
    const gateway = loadConfig(cleanEnv({ ANTHROPIC_AUTH_TOKEN: 'token', ANTHROPIC_BASE_URL: 'https://gw.example' }));
    assert.equal(gateway.auth.authToken, 'token');
    assert.deepEqual(collectMissingConfig(gateway), []);

    assert.equal(collectMissingConfig(loadConfig(cleanEnv({ CLAUDE_CODE_USE_BEDROCK: '1' }))).length, 0);
    assert.equal(collectMissingConfig(loadConfig(cleanEnv({ CLAUDE_CODE_USE_VERTEX: '1' }))).length, 0);
  });

  it('does not implicitly load .env from the working directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-api-env-'));
    const previous = process.cwd();
    fs.writeFileSync(path.join(dir, '.env'), 'ANTHROPIC_API_KEY=from-dotenv-file\n');
    try {
      process.chdir(dir);
      assert.throws(() => loadConfig(cleanEnv()), ConfigError);
    } finally {
      process.chdir(previous);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads an explicitly provided ENV_FILE without overriding real env vars', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-api-envfile-'));
    const envFile = path.join(dir, 'local.env');
    fs.writeFileSync(envFile, 'ANTHROPIC_API_KEY="from-file"\n# comment\nSERVICE_API_KEY=from-file-service\n');
    try {
      const loaded = loadConfig(cleanEnv({ ENV_FILE: envFile }));
      assert.equal(loaded.auth.apiKey, 'from-file');
      assert.equal(loaded.serviceApiKey, 'from-file-service');

      const overridden = loadConfig(cleanEnv({ ENV_FILE: envFile, ANTHROPIC_API_KEY: 'from-process-env' }));
      assert.equal(overridden.auth.apiKey, 'from-process-env');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits non-zero at startup when credentials are missing', async () => {
    const env = cleanEnv({ PORT: '0', LOG_LEVEL: 'error' });
    const child = spawn(process.execPath, ['src/server.js'], {
      cwd: PROJECT_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    const exitCode = await new Promise((resolve) => child.once('exit', resolve));
    assert.equal(exitCode, 1);
    assert.match(stderr, /Missing required environment variable\(s\): ANTHROPIC_API_KEY/);
  });
});
