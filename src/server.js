// Startup and graceful shutdown.

import { buildApp } from './app.js';

const app = await buildApp();
const { config } = app;

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info({ dbPath: config.dbPath, syncIntervalMs: config.syncIntervalMs, maxDepth: config.maxDepth }, 'openpad ready');
} catch (err) {
  app.log.error({ err }, 'failed to start');
  process.exit(1);
}

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, 'shutting down');
  const timer = setTimeout(() => process.exit(1), 10_000);
  timer.unref();
  try {
    await app.close(); // ends live streams, closes the HTTP server and the database (WAL checkpoint)
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'shutdown failed');
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
