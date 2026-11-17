// Arranque e encerramento limpo.

import { buildApp } from './app.js';

const app = await buildApp();
const { config } = app;

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info({ dbPath: config.dbPath, syncIntervalMs: config.syncIntervalMs, maxDepth: config.maxDepth }, 'openpad pronto');
} catch (err) {
  app.log.error({ err }, 'falha no arranque');
  process.exit(1);
}

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, 'a encerrar');
  const timer = setTimeout(() => process.exit(1), 10_000);
  timer.unref();
  try {
    await app.close(); // fecha o servidor HTTP e a base de dados (checkpoint do WAL)
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'falha no encerramento');
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
