// Builds the Fastify application. Kept apart from server.js so tests can use inject().

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { LogController } from 'fastify';
import formbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import { loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { EventHub } from './events.js';
import apiRoutes from './routes/api.js';
import pageRoutes from './routes/pages.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

/**
 * Creates the application. `overrides` replaces configuration values (used by
 * the tests); `logger: false` silences the logs.
 */
export async function buildApp({ overrides = {}, logger, now } = {}) {
  const config = Object.freeze({ ...loadConfig(), ...overrides });
  const db = openDatabase(config.dbPath, now ? { now } : undefined);
  const hub = new EventHub({ maxPerIp: config.maxStreamsPerIp });

  const app = Fastify({
    logger: logger ?? { level: config.logLevel },
    trustProxy: config.trustProxy,
    // The text arrives as x-www-form-urlencoded: each UTF-8 byte can take 3 characters (%XX).
    bodyLimit: config.maxBodyBytes * 3 + 16 * 1024,
    // Turns off Fastify's per-request logs (they include the URL, which is the page's secret).
    logController: new LogController({ disableRequestLogging: true }),
    // Live-update streams must not keep the server from shutting down.
    forceCloseConnections: true,
    routerOptions: { ignoreDuplicateSlashes: true, maxParamLength: 1000 },
    // Badly encoded URL (e.g. "%E0%A4%A"): answered like any other invalid path.
    frameworkErrors(error, request, reply) {
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) reply.header(name, value);
      if (error.code === 'FST_ERR_BAD_URL') {
        if ((request.raw.url || '').startsWith('/api/')) {
          return reply.code(400).header('Cache-Control', 'no-store').send({ error: 'invalid-path' });
        }
        return reply.code(400).type('text/plain; charset=utf-8').send('Invalid page path.\n');
      }
      return reply.code(error.statusCode || 400).send({ error: 'bad-request' });
    },
  });

  app.decorate('config', config);
  app.decorate('db', db);
  app.decorate('hub', hub);

  // Logs: method, route pattern, status code and duration. Never the page path or its text.
  app.addHook('onResponse', async (request, reply) => {
    request.log.info(
      {
        method: request.method,
        route: request.routeOptions?.url ?? 'unknown',
        statusCode: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime * 10) / 10,
      },
      'request',
    );
  });

  app.addHook('onSend', async (request, reply) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) reply.header(name, value);
  });

  app.setErrorHandler((error, request, reply) => {
    if (error.apiError) return reply.code(error.statusCode).send({ error: error.apiError });
    if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') return reply.code(413).send({ error: 'body-too-large' });
    if (error.statusCode && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ error: error.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' ? 'unsupported-media-type' : 'bad-request' });
    }
    request.log.error({ err: error, route: request.routeOptions?.url }, 'unhandled error');
    return reply.code(500).send({ error: 'internal-error' });
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.raw.url.startsWith('/api/')) return reply.code(404).send({ error: 'not-found' });
    return reply.code(404).type('text/plain; charset=utf-8').send('Not found.\n');
  });

  await app.register(formbody, { bodyLimit: config.maxBodyBytes * 3 + 16 * 1024 });
  await app.register(fastifyStatic, {
    root: path.join(PUBLIC_DIR, 'assets'),
    prefix: '/assets/',
    index: false,
    cacheControl: true,
    maxAge: 0,
    etag: true,
  });
  await app.register(apiRoutes, { config, db, hub });
  await app.register(pageRoutes, { config, db, publicDir: PUBLIC_DIR });

  app.addHook('preClose', async () => hub.close());
  app.addHook('onClose', async () => db.close());
  return app;
}
