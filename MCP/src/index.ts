import { createMcpServer } from './mcp/server.js';
import { closeBrowser } from './browser/browser-manager.js';
import { closeDatabase } from './storage/database.js';
import { createLogger } from './utils/logger.js';

const log = createLogger('main');

async function gracefulShutdown(reason: string): Promise<void> {
  log.info(`Shutting down: ${reason}`);
  await closeBrowser().catch((err) => log.error('Browser cleanup failed', err));
  await closeDatabase().catch((err) => log.error('Database cleanup failed', err));
}

async function main() {
  const server = await createMcpServer();

  process.on('SIGINT', async () => {
    await gracefulShutdown('SIGINT');
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await gracefulShutdown('SIGTERM');
    process.exit(0);
  });

  process.on('uncaughtException', async (err) => {
    log.error('Uncaught exception', err);
    await gracefulShutdown('uncaughtException');
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    log.error('Unhandled rejection', reason);
  });
}

main().catch(async (err) => {
  log.error('Fatal error', err);
  await gracefulShutdown('fatal').catch(() => {});
  process.exit(1);
});
