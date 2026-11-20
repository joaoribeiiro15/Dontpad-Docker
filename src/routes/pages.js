// HTML pages (index.html, pad.html), robots.txt and /healthz.

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

  // Any other path is an editing page. A path that is nested too deeply still
  // opens the page: the API answers nesting-limit-reached and the browser shows
  // the message.
  app.get('/*', async (request, reply) => {
    const result = parsePath(request.raw.url.split('?')[0], { maxDepth: config.maxDepth });
    if (!result.ok && result.error === 'invalid-path') {
      return reply.code(400).type('text/plain; charset=utf-8').send('Invalid page path.\n');
    }
    reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-cache').header('X-Robots-Tag', 'noindex');
    return padHtml;
  });
}
