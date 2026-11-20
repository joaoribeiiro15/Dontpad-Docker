import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app.js';

const makeApp = (overrides = {}) => buildApp({ overrides: { dbPath: ':memory:', publicAddress: null, ...overrides }, logger: false });

const form = (fields) => ({
  headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
  payload: new URLSearchParams(fields).toString(),
});

/** The "name=value" part of a Set-Cookie header. */
const cookieOf = (res) => String(res.headers['set-cookie']).split(';')[0];

test('protecting a page: only the person who set it, or who types it, gets in', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());
  const save = (text, lastModified, cookie) =>
    app.inject({ method: 'POST', url: '/api/body/vault', ...form({ text, lastModified: String(lastModified) }), headers: { ...form({}).headers, ...(cookie ? { cookie } : {}) } });

  const v1 = Number((await save('top secret', 0)).body);
  const up = await app.inject({ method: 'POST', url: '/api/files/vault', headers: { 'content-type': 'application/octet-stream', 'x-file-name': 'plan.txt' }, payload: Buffer.from('plan') });
  const fileId = up.json().id;
  await app.inject({ method: 'POST', url: '/api/body/vault/child', ...form({ text: 'open child', lastModified: '0' }) });

  assert.deepEqual((await app.inject('/api/access/vault')).json(), { protected: false, access: true });

  // Too short.
  let res = await app.inject({ method: 'POST', url: '/api/lock/vault', payload: { password: 'abc' } });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.json(), { error: 'invalid-password' });

  res = await app.inject({ method: 'POST', url: '/api/lock/vault', payload: { password: 'correct horse' } });
  assert.equal(res.statusCode, 200);
  const setCookie = String(res.headers['set-cookie']);
  assert.match(setCookie, /^opk_[0-9a-f]{20}=[\w-]+; Path=\/; Max-Age=\d+; HttpOnly; SameSite=Strict$/);
  const owner = cookieOf(res);

  // The person who set it still has access.
  assert.deepEqual((await app.inject({ url: '/api/access/vault', headers: { cookie: owner } })).json(), { protected: true, access: true });
  assert.equal((await app.inject({ url: '/api/body/vault?lastModified=0', headers: { cookie: owner } })).json().body, 'top secret');

  // Everyone else: 401 on every way in.
  assert.deepEqual((await app.inject('/api/access/vault')).json(), { protected: true, access: false });
  const locked = [
    { url: '/api/body/vault?lastModified=0' },
    { method: 'POST', url: '/api/body/vault', ...form({ text: 'x', lastModified: String(v1) }) },
    { method: 'DELETE', url: '/api/body/vault' },
    { url: '/api/events/vault' },
    { url: '/api/menu/vault' },
    { url: '/api/zip/vault' },
    { url: '/api/files/vault' },
    { url: `/api/file/${fileId}` },
    { url: `/api/file/${fileId}/preview` },
    { method: 'PATCH', url: `/api/file/${fileId}`, payload: { x: 0.1, y: 0.1 } },
    { method: 'DELETE', url: `/api/file/${fileId}` },
    { method: 'POST', url: '/api/lock/vault', payload: { password: 'hijacked' } },
    { method: 'DELETE', url: '/api/lock/vault' },
  ];
  for (const req of locked) {
    res = await app.inject(req);
    assert.equal(res.statusCode, 401, `${req.method ?? 'GET'} ${req.url}`);
    assert.deepEqual(res.json(), { error: 'password-required' });
  }
  // A forged or stale cookie does not help.
  const forged = owner.replace(/=.*/, '=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  assert.equal((await app.inject({ url: '/api/body/vault?lastModified=0', headers: { cookie: forged } })).statusCode, 401);

  // Subpages are not protected.
  assert.equal((await app.inject('/api/body/vault/child?lastModified=0')).json().body, 'open child');

  // Wrong password, then the right one.
  res = await app.inject({ method: 'POST', url: '/api/unlock/vault', payload: { password: 'nope' } });
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.json(), { error: 'wrong-password' });
  assert.equal(res.headers['set-cookie'], undefined);
  res = await app.inject({ method: 'POST', url: '/api/unlock/vault', payload: { password: 'correct horse' } });
  assert.equal(res.statusCode, 200);
  const guest = cookieOf(res);
  assert.equal((await app.inject({ url: `/api/file/${fileId}`, headers: { cookie: guest } })).body, 'plan');

  // Changing the password logs out every earlier key, including the guest's.
  res = await app.inject({ method: 'POST', url: '/api/lock/vault', payload: { password: 'new password' }, headers: { cookie: owner } });
  const owner2 = cookieOf(res);
  assert.equal((await app.inject({ url: '/api/body/vault?lastModified=0', headers: { cookie: guest } })).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/body/vault?lastModified=0', headers: { cookie: owner } })).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/body/vault?lastModified=0', headers: { cookie: owner2 } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/api/unlock/vault', payload: { password: 'correct horse' } })).statusCode, 403);

  // Removing it opens the page to everyone again.
  res = await app.inject({ method: 'DELETE', url: '/api/lock/vault', headers: { cookie: owner2 } });
  assert.deepEqual(res.json(), { protected: false });
  assert.match(String(res.headers['set-cookie']), /Max-Age=0/);
  assert.equal((await app.inject('/api/body/vault?lastModified=0')).json().body, 'top secret');
});

test('the .zip of a parent leaves out protected subpages it has not unlocked', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());
  for (const [p, text] of [['/team', 'parent'], ['/team/public', 'everyone'], ['/team/secret', 'hidden']]) {
    await app.inject({ method: 'POST', url: `/api/body${p}`, ...form({ text, lastModified: '0' }) });
  }
  const lock = await app.inject({ method: 'POST', url: '/api/lock/team/secret', payload: { password: 'shhhh' } });
  const key = cookieOf(lock);

  // File names are stored uncompressed in the zip.
  let res = await app.inject('/api/zip/team');
  assert.equal(res.statusCode, 200);
  assert.ok(res.rawPayload.includes(Buffer.from('team/public.txt')));
  assert.ok(!res.rawPayload.includes(Buffer.from('team/secret.txt')));

  res = await app.inject({ url: '/api/zip/team', headers: { cookie: key } });
  assert.ok(res.rawPayload.includes(Buffer.from('team/secret.txt')));
});

test('passwords survive a restart (stored as a hash), unlock attempts are rate-limited', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openpad-locks-'));
  const dbPath = path.join(dir, 'pad.db');
  let app = await makeApp({ dbPath });
  t.after(async () => {
    await app.close(); // the database must be closed before the folder goes (Windows)
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const res = await app.inject({ method: 'POST', url: '/api/lock/diary', payload: { password: 'plaintext-never-stored' } });
  const key = cookieOf(res);
  const row = app.db.raw.prepare('SELECT hash FROM page_locks WHERE path = ?').get('/diary');
  assert.match(row.hash, /^scrypt\$16384\$8\$1\$/);
  assert.ok(!row.hash.includes('plaintext'));
  await app.close();

  app = await makeApp({ dbPath });
  // The access key is still valid after a restart (the signing secret is in the database).
  assert.equal((await app.inject({ url: '/api/body/diary?lastModified=0', headers: { cookie: key } })).statusCode, 200);
  assert.equal((await app.inject('/api/body/diary?lastModified=0')).statusCode, 401);

  const codes = [];
  for (let k = 0; k < 12; k++) {
    codes.push((await app.inject({ method: 'POST', url: '/api/unlock/diary', payload: { password: `guess-${k}` } })).statusCode);
  }
  assert.deepEqual(codes.slice(0, 10), Array(10).fill(403));
  assert.deepEqual(codes.slice(10), [429, 429]);
});

test('setting a password disconnects everyone on the page with `locked`', async (t) => {
  const app = await makeApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  t.after(() => app.close());
  const port = app.server.address().port;

  const stream = new Promise((resolve, reject) => {
    http
      .get({ port, host: '127.0.0.1', path: '/api/events/room' }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve(data));
      })
      .on('error', reject);
  });
  await new Promise((r) => setTimeout(r, 150));
  const res = await fetch(`http://127.0.0.1:${port}/api/lock/room`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'letmein' }),
  });
  assert.equal(res.status, 200);
  assert.match(await stream, /event: locked\ndata: \{\}\n\n$/);
  assert.equal(app.hub.count('/room'), 0);

  // Reconnecting without the key is refused.
  const again = await fetch(`http://127.0.0.1:${port}/api/events/room`);
  assert.equal(again.status, 401);
});
