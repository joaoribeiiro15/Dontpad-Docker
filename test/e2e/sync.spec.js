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
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(new URL(path, page.url()).href);

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

/** Starts a dedicated server, so the test can stop and restart it. */
function startServer(port, dbPath) {
  const child = spawn(process.execPath, ['src/server.js'], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DB_PATH: dbPath, SYNC_INTERVAL_MS: String(POLL), LOG_LEVEL: 'warn' },
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
