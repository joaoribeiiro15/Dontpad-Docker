// API under /api: body, events, menu, config and zip.

import rateLimit from '@fastify/rate-limit';
import { FileStore, MAX_PREVIEW_BYTES } from '../files.js';
import { parsePath } from '../paths.js';
import { buildZip } from '../zip.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Content-Disposition with an ASCII fallback and the UTF-8 name. */
function disposition(kind, name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Extracts and validates the page path from the raw URL, after the route prefix. */
function pagePath(request, prefix, maxDepth) {
  const pathname = request.raw.url.split('?')[0];
  return parsePath(pathname.slice(prefix.length), { maxDepth });
}

function apiError(code, error) {
  return Object.assign(new Error(error), { statusCode: code, apiError: error });
}

export default async function apiRoutes(app, { config, db, hub, files }) {
  await app.register(rateLimit, {
    max: config.rateLimitPerMin,
    timeWindow: 60_000,
    errorResponseBuilder: () => apiError(429, 'rate-limited'),
  });

  app.addHook('onSend', async (request, reply) => {
    if (!reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
    reply.header('X-Robots-Tag', 'noindex');
  });

  // File uploads: the raw bytes, never parsed. Its own body limit (original + preview).
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: config.maxFileBytes + MAX_PREVIEW_BYTES },
    (request, body, done) => done(null, body),
  );

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
    maxFileBytes: config.maxFileBytes,
    maxFilesPerPage: config.maxFilesPerPage,
    fileTtlMs: config.fileTtlMs,
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

  // ---- Temporary shared files (memory only) ----------------------------------

  app.get('/api/files/*', async (request) => files.list(resolve(request, '/api/files')));

  // Body: [preview bytes][original bytes]. Headers describe both parts.
  app.post('/api/files/*', async (request, reply) => {
    const p = resolve(request, '/api/files');
    if (!Buffer.isBuffer(request.body)) throw apiError(415, 'unsupported-media-type');
    const h = request.headers;
    const body = request.body;

    let preview = null;
    const previewLength = Number(h['x-preview-length'] ?? 0);
    if (!Number.isSafeInteger(previewLength) || previewLength < 0 || previewLength > body.length) {
      throw apiError(400, 'invalid-preview');
    }
    if (previewLength > 0) {
      preview = {
        data: body.subarray(0, previewLength),
        type: String(h['x-preview-type'] ?? '').toLowerCase(),
        width: h['x-preview-width'],
        height: h['x-preview-height'],
      };
    }
    const data = body.subarray(previewLength);

    const result = files.add(
      p,
      {
        name: h['x-file-name'],
        type: h['x-file-type'],
        x: request.query.x,
        y: request.query.y,
        width: h['x-image-width'],
        height: h['x-image-height'],
        token: h['x-upload-token'],
      },
      data,
      preview,
    );
    if (!result.ok) {
      const status = { 'file-too-large': 413, 'storage-full': 507, 'too-many-files': 409 }[result.error] ?? 400;
      throw apiError(status, result.error);
    }
    const meta = FileStore.meta(result.file);
    hub.publish(p, 'file-added', meta);
    reply.code(201);
    return meta;
  });

  const fileById = (request) => {
    const id = request.params.id;
    const file = UUID.test(id) ? files.get(id) : null;
    if (!file) throw apiError(404, 'file-not-found');
    return file;
  };

  // The original, always as a download, in a sandbox: it is never rendered on this origin.
  app.get('/api/file/:id', async (request, reply) => {
    const file = fileById(request);
    reply
      .type('application/octet-stream')
      .header('Content-Disposition', disposition('attachment', file.name))
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Cache-Control', 'private, no-store');
    return file.data;
  });

  // The lower-quality image shown on the page.
  app.get('/api/file/:id/preview', async (request, reply) => {
    const file = fileById(request);
    const preview = FileStore.previewOf(file);
    if (!preview) throw apiError(404, 'no-preview');
    reply
      .type(preview.type)
      .header('Content-Disposition', disposition('inline', `preview-${file.name}`))
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Cache-Control', 'private, max-age=3600, immutable');
    return preview.data;
  });

  // Moving is frequent while someone drags a window, so it gets a larger allowance.
  app.patch(
    '/api/file/:id',
    { config: { rateLimit: { max: Math.max(config.rateLimitPerMin * 5, 3000), timeWindow: 60_000 } } },
    async (request) => {
      const file = fileById(request);
      const body = request.body ?? {};
      files.move(file.id, { x: body.x, y: body.y, front: body.front === true });
      const event = { id: file.id, x: file.x, y: file.y, z: file.z, by: typeof body.by === 'string' ? body.by.slice(0, 40) : null };
      hub.publish(file.path, 'file-moved', event);
      return event;
    },
  );

  app.delete('/api/file/:id', async (request) => {
    const file = fileById(request);
    files.remove(file.id);
    hub.publish(file.path, 'file-removed', { id: file.id });
    return { removed: file.id };
  });

  app.all('/api/*', async () => {
    throw apiError(404, 'not-found');
  });
}
