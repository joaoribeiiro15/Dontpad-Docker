import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { buildApp } from '../src/app.js';
import { FileStore, cleanName, cleanType } from '../src/files.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

function store(overrides = {}) {
  let t = 1_000_000;
  const now = () => t;
  now.advance = (ms) => (t += ms);
  return { files: new FileStore({ maxFileBytes: 1000, maxFilesPerPage: 3, maxTotalBytes: 2500, ttlMs: 60_000, now, ...overrides }), now };
}

test('names and types are sanitised', () => {
  assert.equal(cleanName('report%20final.pdf'), 'report final.pdf');
  assert.equal(cleanName('../../etc/passwd'), '.._.._etc_passwd');
  assert.equal(cleanName('a\u0000b<c>.txt'), 'a_b_c_.txt');
  assert.equal(cleanName(''), 'file');
  assert.equal(cleanName('%E0%A4%A'), '%E0%A4%A');
  assert.equal(cleanName('x'.repeat(300) + '.jpeg').length, 200);
  assert.ok(cleanName('x'.repeat(300) + '.jpeg').endsWith('.jpeg'));
  assert.equal(cleanType('image/PNG'), 'image/png');
  assert.equal(cleanType('text/html; charset=utf-8'), 'application/octet-stream');
  assert.equal(cleanType(''), 'application/octet-stream');
});

test('store: add, list, move, remove and limits', () => {
  const { files } = store();
  const a = files.add('/p', { name: 'a.txt', type: 'text/plain', x: 0.2, y: 2 }, Buffer.alloc(400)).file;
  assert.equal(a.x, 0.2);
  assert.equal(a.y, 1); // clamped
  assert.equal(a.z, 1);
  const b = files.add('/p', { name: 'b.png', type: 'image/png' }, Buffer.alloc(400)).file;
  assert.equal(b.z, 2);
  assert.deepEqual(files.add('/p', { name: 'e' }, Buffer.alloc(0)), { ok: false, error: 'empty-file' });
  assert.deepEqual(files.add('/p', { name: 'big' }, Buffer.alloc(1001)), { ok: false, error: 'file-too-large' });

  assert.deepEqual(
    files.list('/p').map((f) => f.name),
    ['a.txt', 'b.png'],
  );
  assert.equal(files.list('/p')[1].preview, true); // small PNG doubles as its own preview
  assert.equal(files.list('/p')[0].preview, false);

  files.move(a.id, { x: 0.9, y: 0.1, front: true });
  assert.equal(a.z, 3);
  assert.deepEqual(
    files.list('/p').map((f) => f.name),
    ['b.png', 'a.txt'],
  );

  files.add('/p', { name: 'c' }, Buffer.alloc(100));
  assert.deepEqual(files.add('/p', { name: 'd' }, Buffer.alloc(100)), { ok: false, error: 'too-many-files' });
  assert.deepEqual(files.add('/q', { name: 'big' }, Buffer.alloc(1000), { data: Buffer.alloc(800), type: 'image/webp' }), {
    ok: false,
    error: 'storage-full',
  });

  files.remove(a.id);
  assert.equal(files.get(a.id), null);
  assert.deepEqual(files.stats(), { files: 2, bytes: 500 });
});

test('store: previews are validated and counted', () => {
  const { files } = store();
  assert.equal(files.add('/p', { name: 'x' }, Buffer.alloc(10), { data: Buffer.alloc(10), type: 'text/html' }).error, 'invalid-preview');
  const r = files.add('/p', { name: 'x.svg', type: 'image/svg+xml', width: 800, height: 600 }, Buffer.alloc(100), {
    data: Buffer.alloc(50),
    type: 'image/webp',
    width: 400,
    height: 300,
  });
  assert.ok(r.ok);
  const meta = FileStore.meta(r.file);
  assert.equal(meta.preview, true);
  assert.deepEqual([meta.width, meta.height, meta.previewWidth, meta.previewHeight], [800, 600, 400, 300]);
  assert.equal(files.stats().bytes, 150);
  // SVG never serves as its own preview.
  const svg = files.add('/p', { name: 'y.svg', type: 'image/svg+xml' }, Buffer.alloc(100)).file;
  assert.equal(FileStore.meta(svg).preview, false);
});

test('store: files expire', () => {
  const { files, now } = store();
  const a = files.add('/p', { name: 'a' }, Buffer.alloc(10)).file;
  now.advance(59_000);
  assert.equal(files.sweep().length, 0);
  now.advance(2_000);
  assert.deepEqual(
    files.sweep().map((f) => f.id),
    [a.id],
  );
  assert.equal(files.list('/p').length, 0);
  assert.equal(files.stats().bytes, 0);
});

// ---- HTTP -------------------------------------------------------------------------

async function makeApp(overrides = {}) {
  return buildApp({ overrides: { dbPath: ':memory:', ...overrides }, logger: false });
}

function upload(app, path, data, headers = {}, query = '') {
  return app.inject({
    method: 'POST',
    url: `/api/files${path}${query}`,
    headers: { 'content-type': 'application/octet-stream', ...headers },
    payload: data,
  });
}

test('upload, list, preview, download, move and delete', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());

  const preview = Buffer.from('fake-webp-preview');
  const original = Buffer.concat([PNG, Buffer.alloc(5000, 7)]);
  let res = await upload(app, '/shared/page', Buffer.concat([preview, original]), {
    'x-file-name': encodeURIComponent('Holiday photo é.png'),
    'x-file-type': 'image/png',
    'x-image-width': '4000',
    'x-image-height': '3000',
    'x-preview-length': String(preview.length),
    'x-preview-type': 'image/webp',
    'x-preview-width': '1280',
    'x-preview-height': '960',
    'x-upload-token': 'tok123',
  }, '?x=0.25&y=0.75');
  assert.equal(res.statusCode, 201);
  const meta = res.json();
  assert.equal(meta.name, 'Holiday photo é.png');
  assert.equal(meta.size, original.length);
  assert.equal(meta.token, 'tok123');
  assert.deepEqual([meta.x, meta.y, meta.width, meta.height, meta.previewWidth, meta.previewHeight, meta.preview], [0.25, 0.75, 4000, 3000, 1280, 960, true]);

  res = await app.inject('/api/files/shared/page');
  assert.deepEqual(
    res.json().map((f) => f.id),
    [meta.id],
  );
  assert.deepEqual((await app.inject('/api/files/shared/other')).json(), []);

  // The page shows the lighter preview...
  res = await app.inject(`/api/file/${meta.id}/preview`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'image/webp');
  assert.deepEqual(res.rawPayload, preview);
  assert.match(res.headers['cache-control'], /max-age=3600/);
  assert.equal(res.headers['content-security-policy'], "default-src 'none'; sandbox");

  // ...and Download returns the untouched original, as an attachment.
  res = await app.inject(`/api/file/${meta.id}`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/octet-stream');
  assert.deepEqual(res.rawPayload, original);
  assert.match(res.headers['content-disposition'], /^attachment; filename="Holiday photo _.png"; filename\*=UTF-8''Holiday%20photo%20%C3%A9.png$/);
  assert.equal(res.headers['content-security-policy'], "default-src 'none'; sandbox");
  assert.equal(res.headers['x-content-type-options'], 'nosniff');

  // Already the topmost window: bringing it to the front keeps its z.
  res = await app.inject({ method: 'PATCH', url: `/api/file/${meta.id}`, payload: { x: 0.5, y: 0.1, front: true, by: 'me' } });
  assert.deepEqual(res.json(), { id: meta.id, x: 0.5, y: 0.1, z: 1, by: 'me' });
  const other = (await upload(app, '/shared/page', Buffer.from('second'))).json();
  assert.equal(other.z, 2);
  res = await app.inject({ method: 'PATCH', url: `/api/file/${meta.id}`, payload: { x: 0.5, y: 0.1, front: true } });
  assert.equal(res.json().z, 3);
  await app.inject({ method: 'DELETE', url: `/api/file/${other.id}` });

  res = await app.inject({ method: 'DELETE', url: `/api/file/${meta.id}` });
  assert.deepEqual(res.json(), { removed: meta.id });
  for (const url of [`/api/file/${meta.id}`, `/api/file/${meta.id}/preview`, '/api/file/not-a-uuid']) {
    res = await app.inject(url);
    assert.equal(res.statusCode, 404, url);
    assert.deepEqual(res.json(), { error: 'file-not-found' });
  }
});

test('a plain file has no preview; an HTML file is never rendered', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());
  const html = Buffer.from('<script>alert(1)</script>');
  const meta = (await upload(app, '/p', html, { 'x-file-name': 'evil.html', 'x-file-type': 'text/html' })).json();
  assert.equal(meta.preview, false);
  assert.equal((await app.inject(`/api/file/${meta.id}/preview`)).statusCode, 404);
  const res = await app.inject(`/api/file/${meta.id}`);
  assert.equal(res.headers['content-type'], 'application/octet-stream');
  assert.match(res.headers['content-disposition'], /^attachment;/);
});

test('upload errors', async (t) => {
  const app = await makeApp({ maxFileBytes: 1000, maxFilesPerPage: 1 });
  t.after(() => app.close());

  let res = await upload(app, '/p', Buffer.alloc(1001));
  assert.equal(res.statusCode, 413);
  assert.deepEqual(res.json(), { error: 'file-too-large' });

  res = await upload(app, '/p', Buffer.alloc(3 * 1024 * 1024)); // above the parser's own limit
  assert.equal(res.statusCode, 413);
  assert.deepEqual(res.json(), { error: 'file-too-large' });

  res = await upload(app, '/p', Buffer.alloc(0));
  assert.deepEqual(res.json(), { error: 'empty-file' });

  res = await upload(app, '/p', Buffer.alloc(10), { 'x-preview-length': '99' });
  assert.deepEqual(res.json(), { error: 'invalid-preview' });

  res = await app.inject({ method: 'POST', url: '/api/files/p', headers: { 'content-type': 'application/json' }, payload: '{"a":1}' });
  assert.equal(res.statusCode, 415);

  res = await upload(app, '/api/x', Buffer.alloc(10)); // "api" is a reserved first segment
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.json(), { error: 'invalid-path' });
  res = await app.inject({ method: 'POST', url: '/api/files/a%00b', headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.alloc(1) });
  assert.deepEqual(res.json(), { error: 'invalid-path' });

  assert.equal((await upload(app, '/p', Buffer.alloc(10))).statusCode, 201);
  res = await upload(app, '/p', Buffer.alloc(10));
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.json(), { error: 'too-many-files' });
});

test('files are memory-only: a restart forgets them', async () => {
  const app1 = await makeApp();
  const meta = (await upload(app1, '/p', Buffer.from('temporary'))).json();
  assert.equal((await app1.inject(`/api/file/${meta.id}`)).statusCode, 200);
  await app1.close();

  const app2 = await makeApp();
  assert.deepEqual((await app2.inject('/api/files/p')).json(), []);
  assert.equal((await app2.inject(`/api/file/${meta.id}`)).statusCode, 404);
  await app2.close();
});

test('live events: file-added, file-moved, file-removed and expiry', async (t) => {
  let now = Date.now();
  const app = await buildApp({ overrides: { dbPath: ':memory:', fileTtlMs: 1000 }, logger: false, now: () => now });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = app.server.address().port;
  t.after(() => app.close());

  const stream = await openStream(port, '/api/events/live');
  await stream.next('hello');

  const meta = (await upload(app, '/live', Buffer.from('hi'), { 'x-file-name': 'hi.txt' })).json();
  assert.equal((await stream.next('file-added')).id, meta.id);

  await app.inject({ method: 'PATCH', url: `/api/file/${meta.id}`, payload: { x: 0.3, y: 0.4, by: 'abc' } });
  assert.deepEqual(await stream.next('file-moved'), { id: meta.id, x: 0.3, y: 0.4, z: 1, by: 'abc' });

  await app.inject({ method: 'DELETE', url: `/api/file/${meta.id}` });
  assert.deepEqual(await stream.next('file-removed'), { id: meta.id });

  const second = (await upload(app, '/live', Buffer.from('soon gone'))).json();
  await stream.next('file-added');
  now += 2000;
  assert.deepEqual(await stream.next('file-removed', 3000), { id: second.id, expired: true });
  stream.close();
});

function openStream(port, target) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: target }, (res) => {
      const events = [];
      const waiters = new Set();
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const event = /^event: (.+)$/m.exec(frame)?.[1];
          const data = /^data: (.+)$/m.exec(frame)?.[1];
          if (event) events.push({ event, data: JSON.parse(data) });
        }
        for (const w of [...waiters]) w();
      });
      const next = (name, timeout = 2000) =>
        new Promise((ok, fail) => {
          const check = () => {
            const i = events.findIndex((e) => e.event === name);
            if (i === -1) return;
            const [found] = events.splice(i, 1);
            waiters.delete(check);
            clearTimeout(timer);
            ok(found.data);
          };
          const timer = setTimeout(() => {
            waiters.delete(check);
            fail(new Error(`no "${name}" event`));
          }, timeout);
          waiters.add(check);
          check();
        });
      resolve({ next, close: () => req.destroy() });
    });
    req.on('error', (err) => (err.code === 'ECONNRESET' ? undefined : reject(err)));
  });
}
