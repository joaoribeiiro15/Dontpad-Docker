// Páginas HTML (index.html, pad.html), robots.txt e /healthz.

import fs from 'node:fs';
import path from 'node:path';
import { parsePath } from '../paths.js';

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export default async function pageRoutes(app, { config, db, publicDir }) {
  const render = (file) =>
    fs.readFileSync(path.join(publicDir, file), 'utf8').replaceAll('{{APP_NAME}}', escapeHtml(config.appName));
  const indexHtml = render('index.html');
  const padHtml = render('pad.html');

  app.get('/healthz', async (request, reply) => {
    if (!db.healthy()) return reply.code(503).send({ status: 'error' });
    return { status: 'ok' };
  });

  app.get('/robots.txt', async (request, reply) => {
    reply.type('text/plain; charset=utf-8').header('Cache-Control', 'public, max-age=86400');
    return 'User-agent: *\nDisallow: /\n';
  });

  app.get('/', async (request, reply) => {
    reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-cache');
    return indexHtml;
  });

  // Qualquer outro caminho é uma página de edição. Um caminho com demasiados
  // níveis abre a página na mesma: é a API que responde nesting-limit-reached
  // e o cliente mostra a mensagem (RF-14).
  app.get('/*', async (request, reply) => {
    const result = parsePath(request.raw.url.split('?')[0], { maxDepth: config.maxDepth });
    if (!result.ok && result.error === 'invalid-path') {
      return reply.code(400).type('text/plain; charset=utf-8').send('Caminho inválido.\n');
    }
    reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-cache').header('X-Robots-Tag', 'noindex');
    return padHtml;
  });
}
