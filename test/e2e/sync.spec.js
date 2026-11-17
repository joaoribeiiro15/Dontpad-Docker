// Critérios de aceitação CA-01 a CA-08 (secção 12), com dois contextos de browser.

import { spawn } from 'node:child_process';
import os from 'node:os';
import nodePath from 'node:path';
import { expect, test } from '@playwright/test';

const SYNC = Number(process.env.SYNC_INTERVAL_MS || 5000);
// Pior caso de propagação (RNF-03): um ciclo para gravar e outro para o outro cliente perguntar.
const PROPAGATION = SYNC * 2 + 2000;

const unique = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

async function openPad(context, path) {
  const page = await context.newPage();
  await page.goto(path);
  await expect(page.locator('#text')).toBeEnabled();
  return page;
}

/** Conta os pedidos à API de uma página. */
function trackApi(page) {
  const log = [];
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (url.pathname.startsWith('/api/body/')) log.push({ method: req.method(), at: Date.now() });
  });
  page.on('response', (res) => {
    const url = new URL(res.url());
    if (url.pathname.startsWith('/api/body/')) log.push({ method: res.request().method(), status: res.status(), at: Date.now(), response: true });
  });
  return log;
}

test('CA-01: a página inicial navega para /<nome> com a textarea vazia e com foco', async ({ page }) => {
  const name = unique('teste');
  await page.goto('/');
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
});

test('CA-02: o texto é gravado no ciclo seguinte e sobrevive a recarregar', async ({ page }) => {
  const path = `/${unique('ca02')}`;
  await page.goto(path);
  await expect(page.locator('#text')).toBeEnabled();
  const api = trackApi(page);

  await page.locator('#text').pressSequentially('olá mundo');
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'saved', { timeout: SYNC + 3000 });
  const posts = api.filter((r) => r.method === 'POST' && r.response);
  expect(posts).toHaveLength(1);
  expect(posts[0].status).toBe(200);

  await page.reload();
  await expect(page.locator('#text')).toHaveValue('olá mundo');
});

test('CA-03: o outro browser recebe o texto sem recarregar', async ({ browser }) => {
  const path = `/${unique('ca03')}`;
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await openPad(ctxA, path);
  const b = await openPad(ctxB, path);

  const started = Date.now();
  await a.locator('#text').fill('escrito no A');
  await expect(b.locator('#text')).toHaveValue('escrito no A', { timeout: PROPAGATION });
  expect(Date.now() - started).toBeLessThanOrEqual(PROPAGATION);

  await ctxA.close();
  await ctxB.close();
});

test('CA-04, CA-05: conflito e Substituir', async ({ browser }) => {
  const path = `/${unique('ca04')}`;
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await openPad(ctxA, path);
  const b = await openPad(ctxB, path);

  // Os dois escrevem no mesmo ciclo, antes de qualquer gravação.
  await a.locator('#text').fill('versão do A');
  await b.locator('#text').fill('versão do B');

  // Um dos dois grava primeiro; o segundo recebe 409 e vê o modal.
  const dialogA = a.locator('#conflict');
  const dialogB = b.locator('#conflict');
  await expect(async () => {
    const openA = await dialogA.evaluate((d) => d.open);
    const openB = await dialogB.evaluate((d) => d.open);
    expect(openA !== openB).toBe(true);
  }).toPass({ timeout: SYNC * 2 + 3000 });

  const loserIsA = await dialogA.evaluate((d) => d.open);
  const [loser, winner, loserText] = loserIsA ? [a, b, 'versão do A'] : [b, a, 'versão do B'];
  await expect(loser.locator('#conflict')).toContainText('alterada noutro lado');

  // CA-05: Substituir mantém o texto local no servidor e chega ao outro browser.
  await loser.locator('#conflict-override').click();
  await expect(loser.locator('#conflict')).not.toBeVisible();
  await expect(loser.locator('#status')).toHaveAttribute('data-state', 'saved', { timeout: SYNC + 3000 });
  await expect(winner.locator('#text')).toHaveValue(loserText, { timeout: PROPAGATION });

  await ctxA.close();
  await ctxB.close();
});

test('CA-06: no modal, Descartar troca o texto local pelo do servidor', async ({ browser, request }) => {
  const path = `/${unique('ca06')}`;
  const ctx = await browser.newContext();
  const page = await openPad(ctx, path);

  // Outra pessoa grava entretanto (pela API), e o utilizador escreve antes de receber essa versão.
  await page.locator('#text').fill('local');
  const res = await request.post(`/api/body${path}`, { form: { text: 'do servidor', lastModified: '0', force: 'false' } });
  expect(res.status()).toBe(200);

  await expect(page.locator('#conflict')).toBeVisible({ timeout: SYNC * 2 + 3000 });
  await page.locator('#conflict-discard').click();
  await expect(page.locator('#text')).toHaveValue('do servidor');
  await expect(page.locator('#conflict')).not.toBeVisible();

  // Depois de descartar não há nada por gravar: não volta a haver conflito.
  await page.waitForTimeout(SYNC * 2);
  await expect(page.locator('#conflict')).not.toBeVisible();
  await ctx.close();
});

test('CA-07: menu lateral com as subpáginas por ordem alfabética', async ({ page, request }) => {
  const base = `/${unique('ca07')}`;
  for (const sub of ['b', 'A']) {
    const res = await request.post(`/api/body${base}/${sub}`, { form: { text: `sub ${sub}`, lastModified: '0', force: 'false' } });
    expect(res.status()).toBe(200);
  }

  await page.goto(base);
  const links = page.locator('#menu a');
  await expect(page.locator('#menu-div')).toBeVisible();
  await expect(links).toHaveText(['A', 'b']);
  await expect(links.nth(0)).toHaveAttribute('href', `${base}/A`);
  await expect(links.nth(1)).toHaveAttribute('href', `${base}/b`);

  await links.nth(1).click();
  await expect(page).toHaveURL(new RegExp(`${base}/b$`));
  await expect(page.locator('#text')).toHaveValue('sub b');
  await expect(page.locator('#menu-div')).toBeHidden(); // /b não tem subpáginas
});

test('CA-08: separador em segundo plano não faz polling e atualiza ao voltar', async ({ browser, request }) => {
  const path = `/${unique('ca08')}`;
  const ctx = await browser.newContext();
  // Permite simular document.hidden, que o Playwright não muda sozinho.
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
  const api = trackApi(page);

  await page.evaluate(() => window.__setHidden(true));
  const hiddenAt = Date.now();
  await request.post(`/api/body${path}`, { form: { text: 'mudou lá fora', lastModified: '0', force: 'false' } });
  await page.waitForTimeout(SYNC * 4);
  expect(api.filter((r) => r.method === 'GET' && r.at > hiddenAt)).toHaveLength(0);
  await expect(page.locator('#text')).toHaveValue('');

  await page.evaluate(() => window.__setHidden(false));
  await expect(page.locator('#text')).toHaveValue('mudou lá fora', { timeout: SYNC + 3000 });
  await ctx.close();
});

test('RF-11 e RF-12: Tab insere tabulação e há aviso ao sair com texto por gravar', async ({ page }) => {
  await page.goto(`/${unique('tab')}`);
  const text = page.locator('#text');
  await expect(text).toBeEnabled();
  await text.pressSequentially('a');
  await page.keyboard.press('Tab');
  await text.pressSequentially('b');
  await expect(text).toHaveValue('a\tb');
  await expect(text).toBeFocused();

  const hasGuard = await page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(hasGuard).toBe(true);
});

test('RF-14: página com demasiados níveis mostra mensagem', async ({ page }) => {
  await page.goto('/' + Array.from({ length: 11 }, (_, i) => `n${i}`).join('/'));
  await expect(page.locator('#message')).toContainText('demasiados níveis');
  await expect(page.locator('#text')).toBeDisabled();
});

/** Arranca um servidor próprio (para o CA-10 o poder parar e voltar a arrancar). */
function startServer(port, dbPath) {
  const child = spawn(process.execPath, ['src/server.js'], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DB_PATH: dbPath, SYNC_INTERVAL_MS: String(SYNC), LOG_LEVEL: 'warn', RATE_LIMIT_PER_MIN: '100000' },
    stdio: 'ignore',
  });
  const ready = (async () => {
    for (let k = 0; k < 100; k++) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return;
      } catch {
        // ainda a arrancar
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('o servidor não arrancou');
  })();
  const stop = () =>
    new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', () => resolve());
      child.kill('SIGTERM');
    });
  return { ready, stop };
}

test('CA-10: com o serviço parado mostra erro, tenta de novo e grava quando volta', async ({ page }) => {
  test.skip(Boolean(process.env.BASE_URL), 'precisa de controlar o processo do servidor');
  const port = 3998;
  const dbPath = nodePath.join(os.tmpdir(), `openpad-ca10-${Date.now()}.db`);
  let server = startServer(port, dbPath);
  await server.ready;

  const url = `http://127.0.0.1:${port}/ca10`;
  await page.goto(url);
  await expect(page.locator('#text')).toBeEnabled();

  await server.stop();
  await page.locator('#text').fill('escrito com o servidor em baixo');
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'error', { timeout: SYNC * 2 + 3000 });

  // Continua a tentar a cada ciclo: ao fim de dois ciclos o estado ainda é erro.
  await page.waitForTimeout(SYNC * 2);
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'error');

  server = startServer(port, dbPath);
  await server.ready;
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'saved', { timeout: SYNC * 2 + 3000 });
  const body = await (await fetch(`http://127.0.0.1:${port}/api/body/ca10?lastModified=0`)).json();
  expect(body.body).toBe('escrito com o servidor em baixo');
  await server.stop();
});

test('XSS: texto e nomes do menu nunca são interpretados como HTML', async ({ page, request }) => {
  const base = `/${unique('xss')}`;
  const payload = '<img src=x onerror="window.__pwned=1">';
  await request.post(`/api/body${base}`, { form: { text: payload, lastModified: '0', force: 'false' } });
  await request.post(`/api/body${base}/${encodeURIComponent(payload)}`, { form: { text: 'x', lastModified: '0', force: 'false' } });
  await page.goto(base);
  await expect(page.locator('#text')).toHaveValue(payload);
  await expect(page.locator('#menu a')).toHaveText([payload]);
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
});
