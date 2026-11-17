// API sob /api: body, menu, config e zip (secções 7 e 8).

import rateLimit from '@fastify/rate-limit';
import { parsePath } from '../paths.js';
import { buildZip } from '../zip.js';

/** Extrai e valida o caminho da página a partir do URL bruto, depois do prefixo da rota. */
function pagePath(request, prefix, maxDepth) {
  const pathname = request.raw.url.split('?')[0];
  return parsePath(pathname.slice(prefix.length), { maxDepth });
}

function apiError(code, error) {
  return Object.assign(new Error(error), { statusCode: code, apiError: error });
}

export default async function apiRoutes(app, { config, db }) {
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
    maxBodyBytes: config.maxBodyBytes, // extra: usado na mensagem de texto demasiado grande
  }));

  // 7.1 Ler: só envia o texto se mudou desde lastModified (0 pede sempre o texto).
  app.get('/api/body/*', async (request) => {
    const p = resolve(request, '/api/body');
    const sent = Number(request.query.lastModified ?? 0);
    const page = db.read(p);
    if (Number.isFinite(sent) && sent !== 0 && sent === page.lastModified) {
      return { changed: false, lastModified: page.lastModified };
    }
    return { changed: true, lastModified: page.lastModified, body: page.body };
  });

  // 7.2 Gravar: controlo de concorrência otimista por lastModified.
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
    reply.type('application/json');
    return JSON.stringify(result.lastModified);
  });

  // 7.3 Menu: só o primeiro nível abaixo do caminho, sem ordem garantida.
  app.get('/api/menu/*', async (request) => db.menu(resolve(request, '/api/menu')));

  // RF-15: página e subpáginas, um .txt por página.
  app.get('/api/zip/*', async (request, reply) => {
    const p = resolve(request, '/api/zip');
    const base = p.slice(0, p.lastIndexOf('/') + 1); // "/notas/" para "/notas/reuniao"
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
