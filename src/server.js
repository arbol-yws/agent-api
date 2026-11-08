import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadConfig, describeCredentials } from './config.js';
import { createLogger } from './logger.js';
import { TaskManager } from './tasks.js';
import { TaskStore } from './taskStore.js';
import { checkClaudeBinary } from './claude.js';
import { createApp } from './app.js';

export async function startServer({ env = process.env } = {}) {
  const config = loadConfig(env);
  const logger = createLogger(config.logLevel);

  fs.mkdirSync(config.workspaceDir, { recursive: true });
  fs.mkdirSync(config.claudeHome, { recursive: true });

  const taskStore = new TaskStore({ dir: config.stateDir, logger });
  taskStore.init();

  let claudeCheck = { ok: true, version: null, error: null, skipped: true };
  if (config.startupCheck) {
    claudeCheck = await checkClaudeBinary({ config });
    if (claudeCheck.ok) {
      logger.info('claude binary detected', { bin: config.claudeBin, version: claudeCheck.version });
    } else {
      logger.warn('claude binary check failed', { bin: config.claudeBin, error: claudeCheck.error });
    }
  }

  const credentials = describeCredentials(config);
  if (credentials.ok) {
    logger.info('credentials detected', { source: credentials.source });
  } else {
    logger.warn('credentials missing', { reason: credentials.reason });
  }

  const manager = new TaskManager({ config, logger, store: taskStore });
  const app = createApp({ config, logger, manager, claudeCheck });

  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(config.port, config.host, () => resolve(instance));
    instance.on('error', reject);
  });

  const address = server.address();
  logger.info('http server listening', {
    host: config.host,
    port: typeof address === 'object' && address ? address.port : config.port,
    workspace_dir: config.workspaceDir,
    state_dir: config.stateDir,
    max_concurrent_tasks: config.maxConcurrentTasks,
    permission_mode: config.permissionMode,
    service_auth: config.serviceApiKey ? 'bearer' : 'disabled',
  });

  return { server, manager, config, logger, claudeCheck };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const boot = await startServer();
  let shuttingDown = false;

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    boot.logger.info('shutdown started', { signal });
    const forceTimer = setTimeout(() => {
      boot.logger.error('shutdown timed out, exiting forcefully');
      process.exit(1);
    }, 15_000);
    forceTimer.unref();

    boot.server.close();
    setTimeout(() => boot.server.closeAllConnections?.(), 2_000).unref();
    await boot.manager.shutdown(8_000);
    boot.logger.info('shutdown complete', { signal });
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    boot.logger.error('unhandled rejection', { reason: String(reason) });
  });
  process.on('uncaughtException', (error) => {
    boot.logger.error('uncaught exception', { error: error.message, stack: error.stack });
  });
}
