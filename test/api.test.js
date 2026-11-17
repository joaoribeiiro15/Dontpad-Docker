import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { buildApp } from '../src/app.js';

async function makeApp(overrides = {}) {
  const app = await buildApp({ overrides: { dbPath: ':memory:', ...overrides }, logger: false });
  return app;
}

const form = (fields) => ({
  headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
  payload: new URLSearchParams(fields).toString(),
});

async function save(app, url, text, lastModified, force = false) {
  return app.inject({ method: 'POST', url, ...form({ text, lastModified: String(lastModified), force: String(force) }) });
}

test('páginas HTML, ficheiros estáticos, robots.txt e healthz', async (t) => {
  const app = await makeApp({ appName: 'teste<pad>' });
  t.after(() => app.close());

  let res = await app.inject('/');
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.match(res.body, /teste&lt;pad&gt;/);
  assert.match(res.body, /your-secret-page/);
  assert.equal(res.headers['content-security-policy'].startsWith("default-src 'self'"), true);
  assert.equal(res.headers['x-frame-options'], 'DENY');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['referrer-policy'], 'no-referrer');

  for (const url of ['/notas', '/notas/reuniao/', '/ol%C3%A1', '/a/b/c/d/e/f/g/h/i/j/k']) {
    res = await app.inject(url);
    assert.equal(res.statusCode, 200, url);
    assert.match(res.body, /id="text" disabled/);
    assert.equal(res.headers['x-robots-tag'], 'noindex');
  }

  // inject() normaliza "..": estes casos vão por um socket TCP em bruto.
  const port = await listen(app);
  assert.match(await rawGet(port, '/a/../b'), /^HTTP\/1\.1 400/);
  assert.match(await rawGet(port, '/a/%2E%2E/b'), /^HTTP\/1\.1 400/);
  assert.match(await rawGet(port, '/api/body/a/../b?lastModified=0'), /^HTTP\/1\.1 400[\s\S]*invalid-path/);

  res = await app.inject('/assets/pad.js');
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /javascript/);
  res = await app.inject('/assets/icons/saved.svg');
  assert.equal(res.statusCode, 200);
  res = await app.inject('/assets/nada.js');
  assert.equal(res.statusCode, 404);

  res = await app.inject('/robots.txt');
  assert.equal(res.body, 'User-agent: *\nDisallow: /\n');

  res = await app.inject('/healthz');
  assert.deepEqual(res.json(), { status: 'ok' });
});

test('GET /api/config', async (t) => {
  const app = await makeApp({ appName: 'x', syncIntervalMs: 1234, requestTimeoutMs: 999 });
  t.after(() => app.close());
  const res = await app.inject('/api/config');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.deepEqual(res.json(), { appName: 'x', syncIntervalMs: 1234, requestTimeoutMs: 999, maxBodyBytes: 1048576 });
});

test('7.1 Ler: changed false quando a versão coincide, texto completo caso contrário', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());

  let res = await app.inject('/api/body/notas/reuniao?lastModified=0');
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.deepEqual(res.json(), { changed: true, lastModified: 0, body: '' });

  res = await save(app, '/api/body/notas/reuniao', 'olá', 0);
  const lm = res.json();

  res = await app.inject(`/api/body/notas/reuniao?lastModified=${lm}`);
  assert.deepEqual(res.json(), { changed: false, lastModified: lm });

  res = await app.inject('/api/body/notas/reuniao?lastModified=0');
  assert.deepEqual(res.json(), { changed: true, lastModified: lm, body: 'olá' });

  res = await app.inject(`/api/body/notas/reuniao?lastModified=${lm - 1}`);
  assert.deepEqual(res.json(), { changed: true, lastModified: lm, body: 'olá' });

  res = await app.inject('/api/body/notas/reuniao');
  assert.equal(res.json().body, 'olá');
});

test('7.2 Gravar: 200, 409, force, 413, 400', async (t) => {
  const app = await makeApp({ maxBodyBytes: 2048, maxDepth: 3 });
  t.after(() => app.close());

  let res = await save(app, '/api/body/p', 'primeiro', 0);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /application\/json/);
  assert.equal(res.headers['cache-control'], 'no-store');
  const lm1 = res.json();
  assert.equal(typeof lm1, 'number');
  assert.ok(lm1 > 1_700_000_000_000);

  res = await save(app, '/api/body/p', 'segundo', lm1);
  assert.equal(res.statusCode, 200);
  const lm2 = res.json();
  assert.ok(lm2 > lm1);

  // Versão antiga: conflito.
  res = await save(app, '/api/body/p', 'atrasado', lm1);
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.json(), { error: 'update-timestamp-mismatch' });

  // Página já existe e o cliente julga que não: conflito.
  res = await save(app, '/api/body/p', 'novo', 0);
  assert.equal(res.statusCode, 409);

  // force=true passa por cima.
  res = await save(app, '/api/body/p', 'forçado', lm1, true);
  assert.equal(res.statusCode, 200);
  assert.ok(res.json() > lm2);
  assert.equal((await app.inject('/api/body/p?lastModified=0')).json().body, 'forçado');

  // Tamanho máximo, em bytes UTF-8.
  res = await save(app, '/api/body/grande', 'x'.repeat(2048), 0);
  assert.equal(res.statusCode, 200);
  res = await save(app, '/api/body/grande2', 'é'.repeat(1025), 0); // 2050 bytes
  assert.equal(res.statusCode, 413);
  assert.deepEqual(res.json(), { error: 'body-too-large' });
  res = await save(app, '/api/body/grande3', 'x'.repeat(50_000), 0); // acima do limite do pedido
  assert.equal(res.statusCode, 413);
  assert.deepEqual(res.json(), { error: 'body-too-large' });

  // Níveis e caminhos.
  res = await save(app, '/api/body/a/b/c/d', 'x', 0);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.json(), { error: 'nesting-limit-reached' });
  res = await app.inject('/api/body/a/b/c/d?lastModified=0');
  assert.deepEqual(res.json(), { error: 'nesting-limit-reached' });

  for (const url of ['/api/body/', '/api/body/api/x', '/api/body/%E0%A4%A', '/api/body/a%00b']) {
    res = await save(app, url, 'x', 0);
    assert.equal(res.statusCode, 400, url);
    assert.deepEqual(res.json(), { error: 'invalid-path' }, url);
  }

  res = await save(app, '/api/body/p', 'x', 'abc');
  assert.equal(res.statusCode, 400);
});

test('7.2 Gravar texto vazio apaga a página', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());
  const lm = (await save(app, '/api/body/apagar', 'texto', 0)).json();
  let res = await save(app, '/api/body/apagar', '', lm);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json(), 0);
  res = await app.inject('/api/body/apagar?lastModified=0');
  assert.deepEqual(res.json(), { changed: true, lastModified: 0, body: '' });
  assert.equal(app.db.raw.prepare('SELECT count(*) FROM pages').pluck().get(), 0);
});

test('caracteres especiais no texto e no caminho', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());
  const text = 'linha 1\nlinha 2\t& = + % 😀 <script>alert(1)</script>';
  const url = '/api/body/' + encodeURIComponent('olá mundo') + '/' + encodeURIComponent('a&b=c');
  assert.equal((await save(app, url, text, 0)).statusCode, 200);
  const res = await app.inject(url + '?lastModified=0');
  assert.equal(res.json().body, text);
  assert.deepEqual(app.db.raw.prepare('SELECT path FROM pages').pluck().all(), ['/olá mundo/a&b=c']);
});

test('7.3 Menu: só o primeiro nível, incluindo descendentes profundos', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());
  for (const p of ['teste/b', 'teste/A', 'teste/fundo/x/y', 'teste0', 'testes/z']) await save(app, `/api/body/${p}`, 'x', 0);

  let res = await app.inject('/api/menu/teste');
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.deepEqual(res.json().sort(), ['A', 'b', 'fundo']);

  res = await app.inject('/api/menu/nada');
  assert.deepEqual(res.json(), []);
});

test('RF-15 Zip: página e subpáginas, um .txt por página', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());
  await save(app, '/api/body/proj', 'raiz', 0);
  await save(app, '/api/body/proj/a', 'á', 0);
  await save(app, '/api/body/proj/a/b', 'bê', 0);
  await save(app, '/api/body/projeto', 'outro', 0);

  const res = await app.inject('/api/zip/proj');
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/zip');
  assert.match(res.headers['content-disposition'], /attachment; filename="proj.zip"/);

  const files = readZip(res.rawPayload);
  assert.deepEqual(files, { 'proj.txt': 'raiz', 'proj/a.txt': 'á', 'proj/a/b.txt': 'bê' });

  // Exportação de uma subpágina: nomes relativos ao último segmento.
  assert.deepEqual(readZip((await app.inject('/api/zip/proj/a')).rawPayload), { 'a.txt': 'á', 'a/b.txt': 'bê' });
});

test('API desconhecida e métodos não suportados', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());
  let res = await app.inject('/api/nada');
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.json(), { error: 'not-found' });
  res = await app.inject({ method: 'DELETE', url: '/api/body/x' });
  assert.equal(res.statusCode, 404);
});

test('429 com limite de pedidos por IP', async (t) => {
  const app = await makeApp({ rateLimitPerMin: 3 });
  t.after(() => app.close());
  for (let k = 0; k < 3; k++) assert.equal((await app.inject('/api/body/x?lastModified=0')).statusCode, 200);
  const res = await app.inject('/api/body/x?lastModified=0');
  assert.equal(res.statusCode, 429);
  assert.deepEqual(res.json(), { error: 'rate-limited' });
  // As páginas e os ficheiros estáticos não contam para o limite.
  assert.equal((await app.inject('/x')).statusCode, 200);
  assert.equal((await app.inject('/healthz')).statusCode, 200);
});

test('persistência em ficheiro: os dados sobrevivem ao reinício', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openpad-'));
  const dbPath = path.join(dir, 'sub', 'openpad.db');
  let app = await makeApp({ dbPath });
  const lm = (await save(app, '/api/body/dura', 'para sempre', 0)).json();
  await app.close();

  app = await makeApp({ dbPath });
  const res = await app.inject('/api/body/dura?lastModified=0');
  assert.deepEqual(res.json(), { changed: true, lastModified: lm, body: 'para sempre' });
  assert.equal(app.db.raw.pragma('journal_mode', { simple: true }), 'wal');
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function listen(app) {
  await app.listen({ port: 0, host: '127.0.0.1' });
  return app.server.address().port;
}

/** Pedido HTTP sem normalização do caminho. */
function rawGet(port, target) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
    });
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => (data += chunk));
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
}

/** Leitor de zip mínimo para os testes (só deflate e store). */
function readZip(buf) {
  const files = {};
  let off = 0;
  while (buf.readUInt32LE(off) === 0x04034b50) {
    const method = buf.readUInt16LE(off + 8);
    const crc = buf.readUInt32LE(off + 14);
    const size = buf.readUInt32LE(off + 18);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const name = buf.subarray(off + 30, off + 30 + nameLen).toString('utf8');
    const start = off + 30 + nameLen + extraLen;
    const data = buf.subarray(start, start + size);
    const raw = method === 8 ? zlib.inflateRawSync(data) : data;
    assert.equal(zlib.crc32(raw), crc, `crc de ${name}`);
    files[name] = raw.toString('utf8');
    off = start + size;
  }
  assert.equal(buf.readUInt32LE(buf.length - 22), 0x06054b50);
  return files;
}
