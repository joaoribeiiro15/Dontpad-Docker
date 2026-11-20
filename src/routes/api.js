// API under /api: body, events, menu, config and zip.

import rateLimit from '@fastify/rate-limit';
import { parsePath } from '../paths.js';
import { buildZip } from '../zip.js';

/** Extracts and validates the page path from the raw URL, after the route prefix. */
function pagePath(request, prefix, maxDepth) {
  const pathname = request.raw.url.split('?')[0];
  return parsePath(pathname.slice(prefix.length), { maxDepth });
}

function apiError(code, error) {
  return Object.assign(new Error(error), { statusCode: code, apiError: error });
}

export default async function apiRoutes(app, { config, db, hub }) {
  await app.register(rateLimit, {
    max: config.rateLimitPerMin,
    timeWindow: 60_000,
    errorResponseBuilder: () => apiError(429, 'rate-limited'),
  });

  app.addHook('onSend', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Robots-Tag', 'noindex');
  });

  const resolve = (request, prefix) => {
    const result = pagePath(request, prefix, config.maxDepth);
    if (!result.ok) throw apiError(400, result.error);
    return result.path;
  };

  app.get('/api/config', async () => ({
    appName: config.appName,
    syncIntervalMs: config.syncIntervalMs,
    requestTimeoutMs: config.requestTimeoutMs,
    maxBodyBytes: config.maxBodyBytes,
    maxDepth: config.maxDepth,
  }));

  // Read: only sends the text when it changed since lastModified (0 always asks for it).
  app.get('/api/body/*', async (request) => {
    const p = resolve(request, '/api/body');
    const sent = Number(request.query.lastModified ?? 0);
    const page = db.read(p);
    if (Number.isFinite(sent) && sent !== 0 && sent === page.lastModified) {
      return { changed: false, lastModified: page.lastModified };
    }
    return { changed: true, lastModified: page.lastModified, body: page.body };
  });

  // Save: optimistic concurrency control on lastModified.
  app.post('/api/body/*', async (request, reply) => {
    const p = resolve(request, '/api/body');
    const form = request.body ?? {};
    const text = typeof form.text === 'string' ? form.text : '';
    const sent = Number(form.lastModified ?? 0);
    const force = form.force === 'true' || form.force === true;

    if (!Number.isSafeInteger(sent) || sent < 0) throw apiError(400, 'invalid-last-modified');
    if (Buffer.byteLength(text, 'utf8') > config.maxBodyBytes) throw apiError(413, 'body-too-large');

    const result = db.save(p, text, sent, force);
    if (!result.ok) throw apiError(409, result.error);
    hub.publish(p, 'change', { lastModified: result.lastModified });
    reply.type('application/json');
    return JSON.stringify(result.lastModified);
  });

  // Live updates (Server-Sent Events): `hello`, `change` and `presence`.
  app.get('/api/events/*', async (request, reply) => {
    const p = resolve(request, '/api/events');
    if (!hub.canAccept(request.ip)) throw apiError(429, 'too-many-streams');

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex',
    });
    res.write(`retry: 2000\n\n`);
    res.write(`event: hello\ndata: ${JSON.stringify({ lastModified: db.read(p).lastModified })}\n\n`);
    hub.subscribe(p, request.ip, res);
  });

  // Direct subpages only, in no particular order.
  app.get('/api/menu/*', async (request) => db.menu(resolve(request, '/api/menu')));

  // The page and its subpages, one .txt per page.
  app.get('/api/zip/*', async (request, reply) => {
    const p = resolve(request, '/api/zip');
    const base = p.slice(0, p.lastIndexOf('/') + 1); // "/notes/" for "/notes/meeting"
    const files = db.tree(p).map((row) => ({ name: row.path.slice(base.length) + '.txt', data: row.body }));
    const leaf = p.slice(base.length);
    const ascii = leaf.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    reply
      .type('application/zip')
      .header('Content-Disposition', `attachment; filename="${ascii}.zip"; filename*=UTF-8''${encodeURIComponent(leaf)}.zip`);
    return buildZip(files);
  });

  app.all('/api/*', async () => {
    throw apiError(404, 'not-found');
  });
}
