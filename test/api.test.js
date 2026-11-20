import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { buildApp } from '../src/app.js';

async function makeApp(overrides = {}) {
  return buildApp({ overrides: { dbPath: ':memory:', ...overrides }, logger: false });
}

const form = (fields) => ({
  headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
  payload: new URLSearchParams(fields).toString(),
});

async function save(app, url, text, lastModified, force = false) {
  return app.inject({ method: 'POST', url, ...form({ text, lastModified: String(lastModified), force: String(force) }) });
}

test('HTML pages, static files, robots.txt and healthz', async (t) => {
  const app = await makeApp({ appName: 'test<pad>' });
  t.after(() => app.close());

  let res = await app.inject('/');
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.match(res.body, /<html lang="en">/);
  assert.match(res.body, /test&lt;pad&gt;/);
  assert.match(res.body, /your-secret-page/);
  assert.equal(res.headers['content-security-policy'].startsWith("default-src 'self'"), true);
  assert.equal(res.headers['x-frame-options'], 'DENY');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['referrer-policy'], 'no-referrer');

  for (const url of ['/notes', '/notes/meeting/', '/ol%C3%A1', '/a/b/c/d/e/f/g/h/i/j/k']) {
    res = await app.inject(url);
    assert.equal(res.statusCode, 200, url);
    assert.match(res.body, /id="text" disabled/);
    assert.equal(res.headers['x-robots-tag'], 'noindex');
  }

  // inject() normalises "..": these go through a raw TCP socket instead.
  const port = await listen(app);
  assert.match(await rawGet(port, '/a/../b'), /^HTTP\/1\.1 400[\s\S]*Invalid page path/);
  assert.match(await rawGet(port, '/a/%2E%2E/b'), /^HTTP\/1\.1 400/);
  assert.match(await rawGet(port, '/api/body/a/../b?lastModified=0'), /^HTTP\/1\.1 400[\s\S]*invalid-path/);

  for (const asset of ['/assets/pad.js', '/assets/merge.js', '/assets/theme.js', '/assets/base.css', '/assets/icons/favicon.svg']) {
    res = await app.inject(asset);
    assert.equal(res.statusCode, 200, asset);
  }
  res = await app.inject('/assets/nothing.js');
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
  assert.deepEqual(res.json(), {
    appName: 'x',
    syncIntervalMs: 1234,
    requestTimeoutMs: 999,
    maxBodyBytes: 1048576,
    maxDepth: 10,
    maxFileBytes: 10 * 1024 * 1024,
    maxFilesPerPage: 20,
    fileTtlMs: 6 * 60 * 60 * 1000,
  });
});

test('read: changed false when the version matches, full text otherwise', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());

  let res = await app.inject('/api/body/notes/meeting?lastModified=0');
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.deepEqual(res.json(), { changed: true, lastModified: 0, body: '' });

  res = await save(app, '/api/body/notes/meeting', 'hello', 0);
  const lm = res.json();

  res = await app.inject(`/api/body/notes/meeting?lastModified=${lm}`);
  assert.deepEqual(res.json(), { changed: false, lastModified: lm });

  res = await app.inject('/api/body/notes/meeting?lastModified=0');
  assert.deepEqual(res.json(), { changed: true, lastModified: lm, body: 'hello' });

  res = await app.inject(`/api/body/notes/meeting?lastModified=${lm - 1}`);
  assert.deepEqual(res.json(), { changed: true, lastModified: lm, body: 'hello' });

  res = await app.inject('/api/body/notes/meeting');
  assert.equal(res.json().body, 'hello');
});

test('save: 200, 409, force, 413, 400', async (t) => {
  const app = await makeApp({ maxBodyBytes: 2048, maxDepth: 3 });
  t.after(() => app.close());

  let res = await save(app, '/api/body/p', 'first', 0);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /application\/json/);
  assert.equal(res.headers['cache-control'], 'no-store');
  const lm1 = res.json();
  assert.equal(typeof lm1, 'number');
  assert.ok(lm1 > 1_700_000_000_000);

  res = await save(app, '/api/body/p', 'second', lm1);
  assert.equal(res.statusCode, 200);
  const lm2 = res.json();
  assert.ok(lm2 > lm1);

  // Stale version: conflict.
  res = await save(app, '/api/body/p', 'late', lm1);
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.json(), { error: 'update-timestamp-mismatch' });

  // The page exists and the client thinks it does not: conflict.
  res = await save(app, '/api/body/p', 'new', 0);
  assert.equal(res.statusCode, 409);

  // force=true overwrites.
  res = await save(app, '/api/body/p', 'forced', lm1, true);
  assert.equal(res.statusCode, 200);
  assert.ok(res.json() > lm2);
  assert.equal((await app.inject('/api/body/p?lastModified=0')).json().body, 'forced');

  // Size limit, in UTF-8 bytes.
  res = await save(app, '/api/body/big', 'x'.repeat(2048), 0);
  assert.equal(res.statusCode, 200);
  res = await save(app, '/api/body/big2', 'é'.repeat(1025), 0); // 2050 bytes
  assert.equal(res.statusCode, 413);
  assert.deepEqual(res.json(), { error: 'body-too-large' });
  res = await save(app, '/api/body/big3', 'x'.repeat(50_000), 0); // over the request limit
  assert.equal(res.statusCode, 413);
  assert.deepEqual(res.json(), { error: 'body-too-large' });

  // Nesting and invalid paths.
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

test('saving empty text deletes the page', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());
  const lm = (await save(app, '/api/body/gone', 'text', 0)).json();
  let res = await save(app, '/api/body/gone', '', lm);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json(), 0);
  res = await app.inject('/api/body/gone?lastModified=0');
  assert.deepEqual(res.json(), { changed: true, lastModified: 0, body: '' });
  assert.equal(app.db.raw.prepare('SELECT count(*) FROM pages').pluck().get(), 0);
});

test('special characters in the text and the path', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());
  const text = 'line 1\nline 2\t& = + % 😀 <script>alert(1)</script>';
  const url = '/api/body/' + encodeURIComponent('olá world') + '/' + encodeURIComponent('a&b=c');
  assert.equal((await save(app, url, text, 0)).statusCode, 200);
  const res = await app.inject(url + '?lastModified=0');
  assert.equal(res.json().body, text);
  assert.deepEqual(app.db.raw.prepare('SELECT path FROM pages').pluck().all(), ['/olá world/a&b=c']);
});

test('menu: first level only, including deep descendants', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());
  for (const p of ['test/b', 'test/A', 'test/deep/x/y', 'test0', 'tests/z']) await save(app, `/api/body/${p}`, 'x', 0);

  let res = await app.inject('/api/menu/test');
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.deepEqual(res.json().sort(), ['A', 'b', 'deep']);

  res = await app.inject('/api/menu/nothing');
  assert.deepEqual(res.json(), []);
});

test('zip: the page and its subpages, one .txt each', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());
  await save(app, '/api/body/proj', 'root', 0);
  await save(app, '/api/body/proj/a', 'á', 0);
  await save(app, '/api/body/proj/a/b', 'bee', 0);
  await save(app, '/api/body/project', 'other', 0);

  const res = await app.inject('/api/zip/proj');
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/zip');
  assert.match(res.headers['content-disposition'], /attachment; filename="proj.zip"/);
  assert.deepEqual(readZip(res.rawPayload), { 'proj.txt': 'root', 'proj/a.txt': 'á', 'proj/a/b.txt': 'bee' });

  // Exporting a subpage: names relative to its last segment.
  assert.deepEqual(readZip((await app.inject('/api/zip/proj/a')).rawPayload), { 'a.txt': 'á', 'a/b.txt': 'bee' });
});

test('unknown API routes and methods', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());
  let res = await app.inject('/api/nothing');
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.json(), { error: 'not-found' });
  res = await app.inject({ method: 'DELETE', url: '/api/body/x' });
  assert.equal(res.statusCode, 404);
});

test('429 with the per-IP rate limit', async (t) => {
  const app = await makeApp({ rateLimitPerMin: 3 });
  t.after(() => app.close());
  for (let k = 0; k < 3; k++) assert.equal((await app.inject('/api/body/x?lastModified=0')).statusCode, 200);
  const res = await app.inject('/api/body/x?lastModified=0');
  assert.equal(res.statusCode, 429);
  assert.deepEqual(res.json(), { error: 'rate-limited' });
  // Pages and static files do not count.
  assert.equal((await app.inject('/x')).statusCode, 200);
  assert.equal((await app.inject('/healthz')).statusCode, 200);
});

test('live events: hello, presence and change', async (t) => {
  const app = await makeApp();
  const port = await listen(app);
  t.after(() => app.close());

  const a = await openStream(port, '/api/events/live/page');
  assert.equal(a.headers['content-type'], 'text/event-stream; charset=utf-8');
  assert.equal(a.headers['cache-control'], 'no-store, no-transform');
  assert.deepEqual(await a.next('hello'), { lastModified: 0 });
  assert.deepEqual(await a.next('presence'), { count: 1 });

  const b = await openStream(port, '/api/events/live/page');
  await b.next('hello');
  assert.deepEqual(await a.next('presence'), { count: 2 });

  // A stream on another page sees nothing from this one.
  const other = await openStream(port, '/api/events/live/other');
  await other.next('presence');

  const res = await save(app, '/api/body/live/page', 'hi', 0);
  const lm = res.json();
  assert.deepEqual(await a.next('change'), { lastModified: lm });
  assert.deepEqual(await b.next('change'), { lastModified: lm });
  assert.equal(other.events.filter((e) => e.event === 'change').length, 0);

  b.close();
  assert.deepEqual(await a.next('presence'), { count: 1 });

  // A new stream starts from the current version.
  const c = await openStream(port, '/api/events/live/page');
  assert.deepEqual(await c.next('hello'), { lastModified: lm });

  a.close();
  c.close();
  other.close();
});

test('live events: invalid paths and the per-IP stream cap', async (t) => {
  const app = await makeApp({ maxStreamsPerIp: 1 });
  const port = await listen(app);
  t.after(() => app.close());

  const bad = await openStream(port, '/api/events/api/x');
  assert.equal(bad.status, 400);
  bad.close();

  const first = await openStream(port, '/api/events/cap');
  assert.equal(first.status, 200);
  const second = await openStream(port, '/api/events/cap');
  assert.equal(second.status, 429);
  assert.deepEqual(JSON.parse(await second.text()), { error: 'too-many-streams' });
  second.close();

  first.close();
  await new Promise((r) => setTimeout(r, 50));
  const third = await openStream(port, '/api/events/cap');
  assert.equal(third.status, 200);
  third.close();
});

test('shutdown ends open live streams', async () => {
  const app = await makeApp();
  const port = await listen(app);
  const s = await openStream(port, '/api/events/bye');
  await s.next('hello');
  const started = Date.now();
  await app.close();
  assert.ok(Date.now() - started < 2000);
  await s.ended;
});

test('file persistence: data survives a restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openpad-'));
  const dbPath = path.join(dir, 'sub', 'openpad.db');
  let app = await makeApp({ dbPath });
  const lm = (await save(app, '/api/body/durable', 'forever', 0)).json();
  await app.close();

  app = await makeApp({ dbPath });
  const res = await app.inject('/api/body/durable?lastModified=0');
  assert.deepEqual(res.json(), { changed: true, lastModified: lm, body: 'forever' });
  assert.equal(app.db.raw.pragma('journal_mode', { simple: true }), 'wal');
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- Helpers ----------------------------------------------------------------

async function listen(app) {
  await app.listen({ port: 0, host: '127.0.0.1' });
  return app.server.address().port;
}

/** HTTP request without path normalisation. */
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

/** Opens an SSE stream and parses its events. */
function openStream(port, target) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: target, headers: { Accept: 'text/event-stream' } }, (res) => {
      const events = [];
      const waiters = [];
      let buffer = '';
      let raw = '';
      let endResolve;
      const ended = new Promise((r) => (endResolve = r));
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        raw += chunk;
        buffer += chunk;
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const event = /^event: (.+)$/m.exec(frame)?.[1];
          const data = /^data: (.+)$/m.exec(frame)?.[1];
          if (event) events.push({ event, data: JSON.parse(data), taken: false });
        }
        for (const w of [...waiters]) w();
      });
      res.on('end', () => endResolve());
      res.on('close', () => endResolve());

      const next = (name, timeout = 2000) =>
        new Promise((ok, fail) => {
          const check = () => {
            const found = events.find((e) => e.event === name && !e.taken);
            if (!found) return false;
            found.taken = true;
            waiters.splice(waiters.indexOf(check), 1);
            clearTimeout(timer);
            ok(found.data);
            return true;
          };
          const timer = setTimeout(() => {
            waiters.splice(waiters.indexOf(check), 1);
            fail(new Error(`no "${name}" event within ${timeout} ms`));
          }, timeout);
          waiters.push(check);
          check();
        });

      resolve({
        status: res.statusCode,
        headers: res.headers,
        events,
        next,
        ended,
        text: () => new Promise((r) => (res.complete ? r(raw) : res.on('end', () => r(raw)))),
        close: () => req.destroy(),
      });
    });
    req.on('error', (err) => (err.code === 'ECONNRESET' ? undefined : reject(err)));
  });
}

/** Minimal zip reader for the tests (deflate and store only). */
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
    assert.equal(zlib.crc32(raw), crc, `crc of ${name}`);
    files[name] = raw.toString('utf8');
    off = start + size;
  }
  assert.equal(buf.readUInt32LE(buf.length - 22), 0x06054b50);
  return files;
}
