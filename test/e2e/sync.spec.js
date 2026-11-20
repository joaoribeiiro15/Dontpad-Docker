// End-to-end tests with real browsers (two contexts = two people).

import { spawn } from 'node:child_process';
import os from 'node:os';
import nodePath from 'node:path';
import { expect, test } from '@playwright/test';

const POLL = Number(process.env.SYNC_INTERVAL_MS || 5000);
// Near real-time: an edit should reach the other browser in well under this.
const LIVE = 3000;

const unique = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

async function openPad(context, path) {
  const page = await context.newPage();
  await page.goto(path);
  await expect(page.locator('#text')).toBeEnabled();
  return page;
}

async function seed(request, path, text) {
  const res = await request.post(`/api/body${path}`, { form: { text, lastModified: '0', force: 'true' } });
  expect(res.status()).toBe(200);
}

/** Records the page's API requests. */
function trackApi(page) {
  const log = [];
  page.on('response', (res) => {
    const url = new URL(res.url());
    if (url.pathname.startsWith('/api/body/')) log.push({ method: res.request().method(), status: res.status(), at: Date.now() });
  });
  return log;
}

test('home page opens /<name> with an empty, focused editor', async ({ page }) => {
  const name = unique('test');
  await page.goto('/');
  await expect(page.locator('h1')).toHaveText('openpad');
  await expect(page.locator('#name')).toBeFocused();
  await expect(page.locator('#name')).toHaveAttribute('placeholder', 'your-secret-page');
  await page.locator('#name').fill(`  ${name}  `);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/${name}$`));
  const text = page.locator('#text');
  await expect(text).toBeEnabled();
  await expect(text).toHaveValue('');
  await expect(text).toBeFocused();
  await expect(page).toHaveTitle(`${name} | openpad`);
  await expect(page.locator('#crumbs a[aria-current="page"]')).toHaveText(name);

  // The page is remembered on the home page.
  await page.goto('/');
  await expect(page.locator('#recent-list a').first()).toContainText(`/${name}`);
});

test('typing is saved within about a second and survives a reload', async ({ page }) => {
  const path = `/${unique('save')}`;
  await page.goto(path);
  await expect(page.locator('#text')).toBeEnabled();
  await expect(page.locator('#sync')).toHaveAttribute('data-state', 'live');
  const api = trackApi(page);

  const started = Date.now();
  await page.locator('#text').pressSequentially('hello world');
  await expect(page.locator('#save')).toHaveAttribute('data-state', 'saved', { timeout: 2000 });
  expect(Date.now() - started).toBeLessThan(2500);
  const posts = api.filter((r) => r.method === 'POST');
  expect(posts.length).toBeGreaterThanOrEqual(1);
  expect(posts.every((r) => r.status === 200)).toBe(true);
  await expect(page.locator('#save-label')).toHaveText('Saved');
  await expect(page.locator('#stats')).toContainText('2 words');

  await page.reload();
  await expect(page.locator('#text')).toHaveValue('hello world');
});

test('the other browser receives edits in near real time', async ({ browser }) => {
  const path = `/${unique('live')}`;
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await openPad(ctxA, path);
  const b = await openPad(ctxB, path);
  await expect(a.locator('#sync')).toHaveAttribute('data-state', 'live');
  await expect(b.locator('#sync')).toHaveAttribute('data-state', 'live');
  await expect(a.locator('#presence-count')).toHaveText('2');

  for (const [from, to, text] of [
    [a, b, 'written in A'],
    [b, a, 'written in A, then B'],
  ]) {
    const started = Date.now();
    await from.locator('#text').fill(text);
    await expect(to.locator('#text')).toHaveValue(text, { timeout: LIVE });
    expect(Date.now() - started).toBeLessThan(LIVE);
  }

  await ctxB.close();
  await expect(a.locator('#presence-count')).toHaveText('1');
  await ctxA.close();
});

test('simultaneous edits to different parts are merged without a dialog', async ({ browser, request }) => {
  const path = `/${unique('merge')}`;
  await seed(request, path, 'alpha\nbeta\ngamma');
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await openPad(ctxA, path);
  const b = await openPad(ctxB, path);

  await Promise.all([a.locator('#text').fill('ALPHA\nbeta\ngamma'), b.locator('#text').fill('alpha\nbeta\nGAMMA')]);

  const merged = 'ALPHA\nbeta\nGAMMA';
  await expect(a.locator('#text')).toHaveValue(merged, { timeout: LIVE * 2 });
  await expect(b.locator('#text')).toHaveValue(merged, { timeout: LIVE * 2 });
  await expect(a.locator('#conflict')).not.toBeVisible();
  await expect(b.locator('#conflict')).not.toBeVisible();
  await expect(a.locator('#save')).toHaveAttribute('data-state', 'saved');
  await expect(b.locator('#save')).toHaveAttribute('data-state', 'saved');
  expect((await (await request.get(`/api/body${path}?lastModified=0`)).json()).body).toBe(merged);

  await ctxA.close();
  await ctxB.close();
});

test('overlapping edits open the conflict dialog; Overwrite keeps the local text', async ({ browser, request }) => {
  const path = `/${unique('conflict')}`;
  await seed(request, path, 'hello world');
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await openPad(ctxA, path);
  const b = await openPad(ctxB, path);

  await Promise.all([a.locator('#text').fill('hello there'), b.locator('#text').fill('hello folks')]);

  const dialogA = a.locator('#conflict');
  const dialogB = b.locator('#conflict');
  await expect(async () => {
    const openA = await dialogA.evaluate((d) => d.open);
    const openB = await dialogB.evaluate((d) => d.open);
    expect(openA !== openB).toBe(true);
  }).toPass({ timeout: LIVE * 2 });

  const loserIsA = await dialogA.evaluate((d) => d.open);
  const [loser, winner, loserText] = loserIsA ? [a, b, 'hello there'] : [b, a, 'hello folks'];
  await expect(loser.locator('#conflict-title')).toHaveText('Conflicting edits');

  await loser.locator('#conflict-override').click();
  await expect(loser.locator('#conflict')).not.toBeVisible();
  await expect(loser.locator('#save')).toHaveAttribute('data-state', 'saved', { timeout: LIVE });
  await expect(winner.locator('#text')).toHaveValue(loserText, { timeout: LIVE });

  await ctxA.close();
  await ctxB.close();
});

test('Discard in the conflict dialog loads the server text', async ({ browser, request }) => {
  const path = `/${unique('discard')}`;
  await seed(request, path, 'hello world');
  const ctx = await browser.newContext();
  const page = await openPad(ctx, path);

  await page.locator('#text').fill('hello there');
  await seed(request, path, 'hello folks');

  await expect(page.locator('#conflict')).toBeVisible({ timeout: LIVE * 2 });
  await page.locator('#conflict-discard').click();
  await expect(page.locator('#text')).toHaveValue('hello folks');
  await expect(page.locator('#conflict')).not.toBeVisible();
  await expect(page.locator('#save')).toHaveAttribute('data-state', 'saved');

  await page.waitForTimeout(1500);
  await expect(page.locator('#conflict')).not.toBeVisible();
  await ctx.close();
});

test('subpages sidebar lists children alphabetically and creates new ones', async ({ page, request }) => {
  const base = `/${unique('subs')}`;
  for (const sub of ['b', 'A']) await seed(request, `${base}/${sub}`, `sub ${sub}`);

  await page.goto(base);
  const links = page.locator('#menu a');
  await expect(page.locator('#sidebar')).toBeVisible();
  await expect(links).toHaveText(['A', 'b']);
  await expect(page.locator('#sub-count')).toHaveText('2');
  await expect(links.nth(0)).toHaveAttribute('href', `${base}/A`);

  await links.nth(1).click();
  await expect(page).toHaveURL(new RegExp(`${base}/b$`));
  await expect(page.locator('#text')).toHaveValue('sub b');
  await expect(page.locator('#sidebar')).toBeHidden(); // /b has no subpages

  await page.locator('#sidebar-toggle').click();
  await expect(page.locator('#sidebar')).toBeVisible();
  await expect(page.locator('#sub-empty')).toBeVisible();
  await page.locator('#sub-name').fill('child page');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`${base}/b/child%20page$`));
  await expect(page.locator('#crumbs a')).toHaveText([base.slice(1), 'b', 'child page']);
});

test('a hidden tab does not fetch updates and catches up when visible again', async ({ browser, request }) => {
  const path = `/${unique('hidden')}`;
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => {
    let hidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
    window.__setHidden = (value) => {
      hidden = value;
      document.dispatchEvent(new Event('visibilitychange'));
    };
  });
  const page = await openPad(ctx, path);
  await expect(page.locator('#sync')).toHaveAttribute('data-state', 'live');
  await page.waitForTimeout(300);
  const api = trackApi(page);

  await page.evaluate(() => window.__setHidden(true));
  const hiddenAt = Date.now();
  await seed(request, path, 'changed elsewhere');
  await page.waitForTimeout(2500);
  expect(api.filter((r) => r.method === 'GET' && r.at > hiddenAt)).toHaveLength(0);
  await expect(page.locator('#text')).toHaveValue('');

  await page.evaluate(() => window.__setHidden(false));
  await expect(page.locator('#text')).toHaveValue('changed elsewhere', { timeout: 2000 });
  await ctx.close();
});

test('Tab inserts a tab, Ctrl+S saves, and leaving with unsaved text warns', async ({ page }) => {
  await page.goto(`/${unique('keys')}`);
  const text = page.locator('#text');
  await expect(text).toBeEnabled();
  await text.pressSequentially('a');
  await page.keyboard.press('Tab');
  await text.pressSequentially('b');
  await expect(text).toHaveValue('a\tb');
  await expect(text).toBeFocused();

  const hasGuard = await page.evaluate(() => {
    const t = document.getElementById('text');
    t.value += 'x';
    t.dispatchEvent(new Event('input'));
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(hasGuard).toBe(true);
  await page.keyboard.press('Control+s');
  await expect(page.locator('#save')).toHaveAttribute('data-state', 'saved', { timeout: 2000 });
});

test('menu: copy link, theme and monospace preferences', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const path = `/${unique('menu')}`;
  await page.goto(path);
  await expect(page.locator('#text')).toBeEnabled();

  await page.locator('#menu-btn').click();
  await expect(page.locator('#menu-pop')).toBeVisible();
  await page.locator('#act-copy').click();
  await expect(page.locator('.toast')).toContainText('Link copied');
  // The link uses the configured public address (PUBLIC_ADDRESS or first-run setup).
  const cfg = await (await page.request.get('/api/config')).json();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe((cfg.publicAddress ?? new URL(page.url()).origin) + path);

  await page.locator('#menu-btn').click();
  await page.locator('#act-theme').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.locator('#act-theme').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.locator('#act-mono').click();
  await expect(page.locator('html')).toHaveAttribute('data-mono', '1');
  await page.keyboard.press('Escape');
  await expect(page.locator('#menu-pop')).toBeHidden();

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('html')).toHaveAttribute('data-mono', '1');
});

test('a page nested too deeply shows a message', async ({ page }) => {
  await page.goto('/' + Array.from({ length: 11 }, (_, i) => `n${i}`).join('/'));
  await expect(page.locator('#message')).toContainText('nested too deeply');
  await expect(page.locator('#text')).toBeDisabled();
});

test('text and subpage names are never interpreted as HTML', async ({ page, request }) => {
  const base = `/${unique('xss')}`;
  const payload = '<img src=x onerror="window.__pwned=1">';
  await seed(request, base, payload);
  await seed(request, `${base}/${encodeURIComponent(payload)}`, 'x');
  await page.goto(base);
  await expect(page.locator('#text')).toHaveValue(payload);
  await expect(page.locator('#menu a')).toHaveText([payload]);
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
});

/** Drops a generated PNG of the given size onto the page, at (x, y). */
async function dropImage(page, { width, height, x, y, name = 'photo.png' }) {
  await page.evaluate(
    async ({ width, height, x, y, name }) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      const g = ctx.createLinearGradient(0, 0, width, height);
      g.addColorStop(0, '#5b5bf0');
      g.addColorStop(1, '#ff8bd1');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, width, height);
      // noise, so the PNG is large and the preview is clearly smaller
      for (let k = 0; k < 4000; k++) {
        ctx.fillStyle = `hsl(${(k * 37) % 360} 70% 60%)`;
        ctx.fillRect((k * 7919) % width, (k * 104729) % height, 12, 12);
      }
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
      const file = new File([blob], name, { type: 'image/png' });
      window.__droppedSize = file.size;
      const dt = new DataTransfer();
      dt.items.add(file);
      const fire = (type) => document.body.dispatchEvent(new DragEvent(type, { dataTransfer: dt, clientX: x, clientY: y, bubbles: true, cancelable: true }));
      fire('dragenter');
      fire('dragover');
      fire('drop');
    },
    { width, height, x, y, name },
  );
  return page.evaluate(() => window.__droppedSize);
}

test('a dropped image floats for everyone with a light preview, and downloads in full quality', async ({ browser, request }) => {
  const path = `/${unique('files')}`;
  const ctxA = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const ctxB = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const a = await openPad(ctxA, path);
  const b = await openPad(ctxB, path);
  await expect(b.locator('#sync')).toHaveAttribute('data-state', 'live');

  const size = await dropImage(a, { width: 2400, height: 1600, x: 400, y: 300 });

  // A sees its picture immediately; B sees the window appear in real time.
  const winA = a.locator('.file-win').first();
  await expect(winA.locator('.file-thumb img')).toBeVisible();
  const winB = b.locator('.file-win').first();
  await expect(winB).toBeVisible({ timeout: LIVE * 2 });
  await expect(winB.locator('.file-name')).toHaveText('photo.png');
  await expect(winB.locator('.file-size')).toContainText('2400 × 1600');
  await expect(winB.locator('.file-thumb')).toHaveClass(/loaded/);

  // The preview on the page is a reduced copy...
  const shown = await winB.locator('.file-thumb img').evaluate((img) => ({ w: img.naturalWidth, h: img.naturalHeight, src: img.getAttribute('src') }));
  expect(shown.w).toBe(1280);
  expect(shown.h).toBe(853);
  const previewBytes = (await (await request.get(shown.src)).body()).length;
  expect(previewBytes).toBeLessThan(size);

  // ...and the download is the original, byte for byte in size.
  await expect(winB.locator('.file-download')).toHaveText('Download original');
  const href = await winB.locator('.file-download').getAttribute('href');
  const original = await request.get(href);
  expect(original.headers()['content-disposition']).toContain('attachment');
  expect((await original.body()).length).toBe(size);

  // Lightbox with the larger preview. (force: the window gently floats, so it is never "stable".)
  await winB.locator('.file-thumb').click({ force: true });
  await expect(b.locator('#lightbox')).toBeVisible();
  await expect(b.locator('.lightbox-info')).toContainText('2400 × 1600');
  await b.keyboard.press('Escape');
  await expect(b.locator('#lightbox')).toBeHidden();

  // Dragging in A moves the window in B.
  const before = await winB.evaluate((el) => el.style.transform);
  const head = await winA.locator('.file-head').boundingBox();
  await a.mouse.move(head.x + 60, head.y + 15);
  await a.mouse.down();
  for (let k = 1; k <= 10; k++) await a.mouse.move(head.x + 60 + k * 40, head.y + 15 + k * 25, { steps: 2 });
  await a.mouse.up();
  await expect(async () => {
    expect(await winB.evaluate((el) => el.style.transform)).not.toBe(before);
  }).toPass({ timeout: LIVE });
  const posA = await winA.evaluate((el) => el.style.transform);
  await expect(async () => {
    expect(await winB.evaluate((el) => el.style.transform)).toBe(posA);
  }).toPass({ timeout: LIVE });

  // Removing in B (two clicks) removes it for A.
  await winB.locator('.file-close').click({ force: true });
  await expect(winB.locator('.file-close')).toHaveClass(/armed/);
  await winB.locator('.file-close').click({ force: true });
  await expect(b.locator('.file-win')).toHaveCount(0);
  await expect(a.locator('.file-win')).toHaveCount(0, { timeout: LIVE });

  await ctxA.close();
  await ctxB.close();
});

test('the paperclip shares any file; late joiners see it too', async ({ browser }) => {
  const path = `/${unique('attach')}`;
  const ctxA = await browser.newContext();
  const a = await openPad(ctxA, path);
  await a.locator('#file-input').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello from a file') });
  const win = a.locator('.file-win');
  await expect(win).toHaveCount(1);
  await expect(win.locator('.badge-ext')).toHaveText('TXT');
  await expect(win.locator('.file-download')).toHaveText('Download');
  await expect(win.locator('.file-download')).toHaveAttribute('href', /\/api\/file\//);
  await expect(win.locator('.file-expiry')).toContainText('Expires in');

  const ctxB = await browser.newContext();
  const b = await openPad(ctxB, path);
  await expect(b.locator('.file-win .file-name')).toHaveText('notes.txt');

  // Minimising is local to each browser.
  await b.locator('.file-collapse').click({ force: true });
  await expect(b.locator('.file-win')).toHaveClass(/collapsed/);
  await expect(a.locator('.file-win')).not.toHaveClass(/collapsed/);

  await ctxA.close();
  await ctxB.close();
});

/** Starts a dedicated server, so the test can stop and restart it. */
function startServer(port, dbPath, extraEnv = {}) {
  const child = spawn(process.execPath, ['src/server.js'], {
    env: { ...process.env, PUBLIC_ADDRESS: '', PORT: String(port), HOST: '127.0.0.1', DB_PATH: dbPath, SYNC_INTERVAL_MS: String(POLL), LOG_LEVEL: 'warn', ...extraEnv },
    stdio: 'ignore',
  });
  const ready = (async () => {
    for (let k = 0; k < 100; k++) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return;
      } catch {
        // still starting
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('server did not start');
  })();
  const stop = () =>
    new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', () => resolve());
      child.kill('SIGTERM');
    });
  return { ready, stop };
}

test('with the server down: offline and not-saved indicators, then saves when it is back', async ({ page }) => {
  test.skip(Boolean(process.env.BASE_URL), 'needs to control the server process');
  const port = 3998;
  const dbPath = nodePath.join(os.tmpdir(), `openpad-offline-${Date.now()}.db`);
  let server = startServer(port, dbPath);
  await server.ready;

  const url = `http://127.0.0.1:${port}/offline`;
  await page.goto(url);
  await expect(page.locator('#text')).toBeEnabled();
  await expect(page.locator('#sync')).toHaveAttribute('data-state', 'live');

  await server.stop();
  await page.locator('#text').fill('written while the server was down');
  await expect(page.locator('#save')).toHaveAttribute('data-state', 'error', { timeout: POLL + 3000 });
  await expect(page.locator('#sync')).toHaveAttribute('data-state', 'offline');

  server = startServer(port, dbPath);
  await server.ready;
  await expect(page.locator('#save')).toHaveAttribute('data-state', 'saved', { timeout: POLL * 2 + 3000 });
  await expect(page.locator('#sync')).toHaveAttribute('data-state', 'live', { timeout: POLL + 5000 });
  const body = await (await fetch(`http://127.0.0.1:${port}/api/body/offline?lastModified=0`)).json();
  expect(body.body).toBe('written while the server was down');
  await server.stop();
});

test('first-run setup asks for the address once and remembers it across restarts', async ({ page }) => {
  test.skip(Boolean(process.env.BASE_URL), 'needs a fresh server');
  const port = 3997;
  const dbPath = nodePath.join(os.tmpdir(), `openpad-setup-${Date.now()}.db`);
  let server = startServer(port, dbPath);
  await server.ready;
  const home = `http://127.0.0.1:${port}/`;

  await page.goto(home);
  const setup = page.locator('#setup');
  await expect(setup).toBeVisible();
  await expect(page.locator('#setup-address')).toBeFocused();
  await expect(page.locator('#setup-address')).toHaveValue(`127.0.0.1:${port}`);
  await expect(page.locator('#setup-link')).toHaveText(`http://127.0.0.1:${port}/your-secret-page`);

  await page.locator('#setup-address').fill('notes.example.com/some/path');
  await expect(page.locator('#setup-link')).toContainText('does not look like an address');
  await page.locator('#setup-address').fill('notes.example.com');
  await expect(page.locator('#setup-link')).toHaveText('https://notes.example.com/your-secret-page');
  await page.locator('#setup-save').click();
  await expect(setup).toBeHidden();
  await expect(page.locator('#host-label')).toHaveText('notes.example.com/');

  // Only once: a second setup is refused.
  const again = await page.request.post(`${home}api/setup`, { data: { address: 'evil.example.com' } });
  expect(again.status()).toBe(409);

  // Remembered after a restart (it lives in the database on the /data volume).
  await server.stop();
  server = startServer(port, dbPath);
  await server.ready;
  await page.goto(home);
  await expect(page.locator('#host-label')).toHaveText('notes.example.com/');
  await expect(setup).toBeHidden();
  await expect(page.locator('#name')).toBeFocused();
  const cfg = await (await page.request.get(`${home}api/config`)).json();
  expect(cfg.publicAddress).toBe('https://notes.example.com');
  await server.stop();
});

test('deleting a page kicks everyone on it back to the home page', async ({ browser, request }) => {
  const path = `/${unique('doomed')}`;
  await seed(request, path, 'line one\nline two\nsome words that will fall away');
  await seed(request, `${path}/child`, 'a subpage survives');
  const upload = await request.post(`/api/files${path}`, {
    headers: { 'content-type': 'application/octet-stream', 'x-file-name': 'notes.txt', 'x-file-type': 'text/plain' },
    data: Buffer.from('temporary'),
  });
  expect(upload.status()).toBe(201);

  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await openPad(ctxA, path);
  const b = await openPad(ctxB, path);
  await expect(a.locator('#presence-count')).toHaveText('2');
  await expect(b.locator('.file-win')).toHaveCount(1);
  const staleVersion = await b.evaluate(async (p) => (await (await fetch(`/api/body${p}?lastModified=0`)).json()).lastModified, path);

  await a.locator('#menu-btn').click();
  await a.locator('#act-delete').click();
  await expect(a.locator('#delete-dialog')).toBeVisible();
  await expect(a.locator('#delete-path')).toHaveText(path);
  await expect(a.locator('#delete-others')).toContainText('1 other person');
  await a.locator('#delete-confirm').click();

  // Both see the deletion, with the right message, then land on the home page.
  for (const [page, who] of [[a, 'You deleted it'], [b, 'Someone deleted it']]) {
    await expect(page.locator('body')).toHaveClass(/page-deleting/);
    await expect(page.locator('#deleted')).toBeVisible();
    await expect(page.locator('#deleted-text')).toContainText(who);
  }
  await expect(b.locator('.crumble span.fall').first()).toBeAttached();
  await expect(a).toHaveURL(/\/$/, { timeout: 8000 });
  await expect(b).toHaveURL(/\/$/, { timeout: 8000 });
  await expect(b.locator('#recent-list a', { hasText: path })).toHaveCount(0);

  // Gone on the server: text and files. The subpage is kept.
  const body = await (await request.get(`/api/body${path}?lastModified=0`)).json();
  expect(body).toMatchObject({ lastModified: 0, body: '' });
  expect(await (await request.get(`/api/files${path}`)).json()).toEqual([]);
  expect((await (await request.get(`/api/body${path}/child?lastModified=0`)).json()).body).toBe('a subpage survives');

  // A browser that still holds the old version can't quietly bring it back...
  const stale = await request.post(`/api/body${path}`, { form: { text: 'zombie', lastModified: String(staleVersion), force: 'true' } });
  expect(stale.status()).toBe(410);
  // ...but anyone can start the page again from scratch.
  await seed(request, path, 'a fresh start');

  await ctxA.close();
  await ctxB.close();
});
