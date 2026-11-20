import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { normalizeAddress } from '../src/address.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const makeApp = (overrides = {}) => buildApp({ overrides: { dbPath: ':memory:', publicAddress: null, ...overrides }, logger: false });

const form = (fields) => ({
  headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
  payload: new URLSearchParams(fields).toString(),
});

test('normalizeAddress: domains get https, local names and IPs get http', () => {
  const ok = (input, origin) => assert.deepEqual(normalizeAddress(input), { ok: true, origin, host: new URL(origin).host }, input);
  ok('notes.example.com', 'https://notes.example.com');
  ok('  Notes.Example.com/  ', 'https://notes.example.com');
  ok('notes.example.com:8443', 'https://notes.example.com:8443');
  ok('http://notes.example.com', 'http://notes.example.com');
  ok('https://pad.example.org:443/', 'https://pad.example.org');
  ok('localhost:3000', 'http://localhost:3000');
  ok('192.168.1.20:3000', 'http://192.168.1.20:3000');
  ok('pad.lan', 'http://pad.lan');
  ok('ubuntu-vm.local:3000', 'http://ubuntu-vm.local:3000');
  ok('[::1]:3000', 'http://[::1]:3000');

  for (const bad of ['', '   ', 'notes.example.com/page', 'ftp://x.com', 'https://user:pw@x.com', 'x.com?a=1', 'x.com#a', 'two words.com', 'javascript:alert(1)', '-bad-.com', 'a..b', 42, null]) {
    assert.deepEqual(normalizeAddress(bad), { ok: false, error: 'invalid-address' }, String(bad));
  }
});

test('PUBLIC_ADDRESS is validated at startup', () => {
  assert.equal(loadConfig({ PUBLIC_ADDRESS: 'notes.example.com' }).publicAddress, 'https://notes.example.com');
  assert.equal(loadConfig({ PUBLIC_ADDRESS: '' }).publicAddress, null);
  assert.throws(() => loadConfig({ PUBLIC_ADDRESS: 'not an address' }), /PUBLIC_ADDRESS/);
});

test('first-run setup: asked once, shown on the home page, kept in the database', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openpad-setup-'));
  const dbPath = path.join(dir, 'pad.db');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  let app = await makeApp({ dbPath });
  let res = await app.inject({ url: '/', headers: { host: 'my-vm:3000' } });
  assert.match(res.body, /data-setup="required"/);
  assert.match(res.body, /id="host-label" class="host">my-vm:3000\/</);
  assert.equal((await app.inject('/api/config')).json().publicAddress, null);

  // A hostile Host header is escaped, never markup.
  res = await app.inject({ url: '/', headers: { host: '<b>x</b>' } });
  assert.match(res.body, /&lt;b&gt;x&lt;\/b&gt;\//);

  res = await app.inject({ method: 'POST', url: '/api/setup', payload: { address: 'nope nope' } });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.json(), { error: 'invalid-address' });

  res = await app.inject({ method: 'POST', url: '/api/setup', payload: { address: 'notes.example.com' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { publicAddress: 'https://notes.example.com', host: 'notes.example.com' });

  res = await app.inject({ method: 'POST', url: '/api/setup', payload: { address: 'other.example.com' } });
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.json(), { error: 'already-configured' });

  res = await app.inject({ url: '/', headers: { host: 'my-vm:3000' } });
  assert.match(res.body, /data-setup="done"/);
  assert.match(res.body, /class="host">notes\.example\.com\/</);
  await app.close();

  // A new process with the same database remembers it.
  app = await makeApp({ dbPath });
  assert.equal((await app.inject('/api/config')).json().publicAddress, 'https://notes.example.com');
  await app.close();

  // PUBLIC_ADDRESS wins over the stored value, and setup is closed.
  app = await makeApp({ dbPath, publicAddress: 'http://10.0.0.5:8080' });
  assert.equal((await app.inject('/api/config')).json().publicAddress, 'http://10.0.0.5:8080');
  assert.match((await app.inject('/')).body, /class="host">10\.0\.0\.5:8080\/</);
  res = await app.inject({ method: 'POST', url: '/api/setup', payload: { address: 'x.example.com' } });
  assert.deepEqual(res.json(), { error: 'configured-by-env' });
  await app.close();
});

test('deleting a page: text and files go, subpages stay, stale saves get 410', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());

  const save = (url, text, lastModified, force = false) =>
    app.inject({ method: 'POST', url, ...form({ text, lastModified: String(lastModified), force: String(force) }) });

  const v1 = Number((await save('/api/body/team', 'hello', 0)).body);
  await save('/api/body/team/child', 'kept', 0);
  const up = await app.inject({
    method: 'POST',
    url: '/api/files/team',
    headers: { 'content-type': 'application/octet-stream', 'x-file-name': 'a.txt' },
    payload: Buffer.from('abc'),
  });
  assert.equal(up.statusCode, 201);

  let res = await app.inject({ method: 'DELETE', url: '/api/body/team' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { deleted: true, existed: true, removedFiles: 1, kicked: 0 });

  assert.deepEqual((await app.inject('/api/body/team?lastModified=0')).json(), { changed: true, lastModified: 0, body: '' });
  assert.deepEqual((await app.inject('/api/files/team')).json(), []);
  assert.equal((await app.inject(`/api/file/${up.json().id}`)).statusCode, 404);
  assert.equal((await app.inject('/api/body/team/child?lastModified=0')).json().body, 'kept');

  // Someone who still had the old version: polling and saving (even forced) get 410.
  res = await app.inject(`/api/body/team?lastModified=${v1}`);
  assert.equal(res.statusCode, 410);
  assert.deepEqual(res.json(), { error: 'page-deleted' });
  assert.equal((await save('/api/body/team', 'zombie', v1, true)).statusCode, 410);
  assert.equal((await app.inject('/api/body/team?lastModified=0')).json().body, '');

  // A fresh start is allowed, and then it is a normal page again.
  const v2 = Number((await save('/api/body/team', 'new life', 0)).body);
  assert.ok(v2 > 0);
  assert.equal((await save('/api/body/team', 'newer', v2)).statusCode, 200);

  // Deleting a page that never existed is harmless; invalid paths are refused.
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/body/never' })).json().existed, false);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/body/api/x' })).statusCode, 400);
});

test('deleting a page sends `deleted` to everyone on it and closes their streams', async (t) => {
  const app = await makeApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  t.after(() => app.close());
  const port = app.server.address().port;

  const listen = (page) =>
    new Promise((resolve, reject) => {
      const req = http.get({ port, host: '127.0.0.1', path: `/api/events/${page}` }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
    });

  const one = listen('room');
  const two = listen('room');
  const other = http.get({ port, host: '127.0.0.1', path: '/api/events/elsewhere' });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(app.hub.count('/room'), 2);

  const res = await fetch(`http://127.0.0.1:${port}/api/body/room`, { method: 'DELETE' });
  assert.equal((await res.json()).kicked, 2);

  for (const stream of await Promise.all([one, two])) {
    assert.match(stream, /event: deleted\ndata: \{"by":null\}\n\n$/);
  }
  assert.equal(app.hub.count('/room'), 0);
  assert.equal(app.hub.count('/elsewhere'), 1);
  other.destroy();
});
