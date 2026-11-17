// Página de edição: carregamento, ciclo de sincronização, menu e modal de conflito
// (secções 8 e 9.2 da especificação).

const TICK_MS = 100;
const MAX_INTERVAL_MS = 60_000;
const SAVED_VISIBLE_MS = 2000;

const textarea = document.getElementById('text');
const statusEl = document.getElementById('status');
const statusIcon = document.getElementById('status-icon');
const messageEl = document.getElementById('message');
const menuDiv = document.getElementById('menu-div');
const menuList = document.getElementById('menu');
const zipLink = document.getElementById('zip');
const dialog = document.getElementById('conflict');

// ---- Caminho da página --------------------------------------------------

function currentPath() {
  let decoded;
  try {
    decoded = decodeURIComponent(location.pathname);
  } catch {
    return null;
  }
  const segments = decoded.split('/').filter((s) => s !== '');
  return segments.length ? '/' + segments.join('/') : null;
}

const pagePath = currentPath();
const encodedPath = pagePath ? pagePath.split('/').map(encodeURIComponent).join('/') : '';
if (pagePath && encodedPath !== location.pathname) {
  history.replaceState(null, '', encodedPath + location.search + location.hash);
}

// ---- Estado (tabela da secção 8) ----------------------------------------

const state = {
  savedText: '',
  lastModified: 0,
  actionRunning: null, // null | 'SAVE' | 'UPDATE'
  lastAction: 0,
  forceOverride: false,
  baseInterval: 5000,
  interval: 5000,
  timeoutMs: 10000,
  loaded: false,
  blocked: false, // erro permanente (ex.: nesting-limit-reached)
  rejectedText: null, // texto recusado com 413, não se repete até mudar
};

// ---- Utilitários ----------------------------------------------------------

class HttpError extends Error {
  constructor(status, code) {
    super(code || `HTTP ${status}`);
    this.status = status;
    this.code = code;
  }
}

async function request(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), state.timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal, cache: 'no-store', credentials: 'same-origin' });
    let data = null;
    const type = res.headers.get('content-type') || '';
    if (type.includes('application/json')) data = await res.json();
    if (!res.ok) throw new HttpError(res.status, data && data.error);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

const api = (kind) => `/api/${kind}${encodedPath}`;

function getBody(lastModified) {
  return request(`${api('body')}?lastModified=${encodeURIComponent(lastModified)}`, { headers: { Accept: 'application/json' } });
}

function postBody(text, lastModified, force) {
  const body = new URLSearchParams({ text, lastModified: String(lastModified), force: force ? 'true' : 'false' });
  return request(api('body'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', Accept: 'application/json' },
    body,
  });
}

// ---- Indicador de estado e mensagens --------------------------------------

const ICONS = { saving: '/assets/icons/saving.svg', saved: '/assets/icons/saved.svg', error: '/assets/icons/error.svg' };
const LABELS = { saving: 'A gravar…', saved: 'Gravado', error: 'Erro, nova tentativa em breve' };
let statusToken = 0;

function setStatus(kind) {
  statusToken += 1;
  if (!kind) {
    statusEl.hidden = true;
    delete statusEl.dataset.state;
    return;
  }
  statusEl.dataset.state = kind;
  statusEl.title = LABELS[kind];
  statusEl.setAttribute('aria-label', LABELS[kind]);
  statusIcon.src = ICONS[kind];
  statusEl.hidden = false;
  if (kind === 'saved') {
    const token = statusToken;
    setTimeout(() => {
      if (token === statusToken) setStatus(null);
    }, SAVED_VISIBLE_MS);
  }
}

let messageKind = null;
function showMessage(text, kind = 'info') {
  messageEl.textContent = text;
  messageEl.hidden = false;
  messageKind = kind;
}

function hideMessage(kind) {
  if (kind && messageKind !== kind) return;
  messageEl.hidden = true;
  messageEl.textContent = '';
  messageKind = null;
}

function formatBytes(n) {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1).replace('.0', '')} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

// ---- Aplicar texto remoto preservando cursor e scroll -------------------

function mapOffset(pos, prefix, oldEnd, newEnd) {
  if (pos <= prefix) return pos;
  if (pos >= oldEnd) return pos - oldEnd + newEnd;
  return newEnd; // dentro da zona alterada: fica no fim do texto novo
}

function replaceText(next) {
  const old = textarea.value;
  if (old === next) return;
  const { selectionStart, selectionEnd, scrollTop } = textarea;
  const hadFocus = document.activeElement === textarea;

  let prefix = 0;
  const max = Math.min(old.length, next.length);
  while (prefix < max && old.charCodeAt(prefix) === next.charCodeAt(prefix)) prefix++;
  let suffix = 0;
  while (suffix < max - prefix && old.charCodeAt(old.length - 1 - suffix) === next.charCodeAt(next.length - 1 - suffix)) suffix++;

  textarea.value = next;
  if (hadFocus) {
    const oldEnd = old.length - suffix;
    const newEnd = next.length - suffix;
    textarea.setSelectionRange(mapOffset(selectionStart, prefix, oldEnd, newEnd), mapOffset(selectionEnd, prefix, oldEnd, newEnd));
  }
  textarea.scrollTop = scrollTop;
}

// ---- Tratamento comum de erros --------------------------------------------

function handleFailure(err) {
  if (err instanceof HttpError) {
    if (err.status === 429) {
      state.interval = Math.min(state.interval * 2, MAX_INTERVAL_MS);
      setStatus('error');
      return;
    }
    if (err.code === 'nesting-limit-reached') {
      state.blocked = true;
      textarea.disabled = true;
      setStatus(null);
      showMessage('Esta página tem demasiados níveis de subpáginas e não pode ser editada.', 'fatal');
      return;
    }
    if (err.code === 'invalid-path') {
      state.blocked = true;
      textarea.disabled = true;
      setStatus(null);
      showMessage('O endereço desta página não é válido.', 'fatal');
      return;
    }
  }
  // Rede, timeout ou erro do servidor: tenta de novo no ciclo seguinte.
  setStatus('error');
}

function onSuccess() {
  state.interval = state.baseInterval;
  if (statusEl.dataset.state === 'error') setStatus(null);
}

// ---- Ações do ciclo ----------------------------------------------------------

async function save() {
  const sentText = textarea.value;
  state.actionRunning = 'SAVE';
  state.lastAction = Date.now();
  setStatus('saving');
  try {
    const lastModified = await postBody(sentText, state.lastModified, state.forceOverride);
    state.lastModified = Number(lastModified);
    state.savedText = sentText; // o texto enviado, não o atual da textarea
    state.forceOverride = false;
    state.rejectedText = null;
    hideMessage('too-large');
    state.interval = state.baseInterval;
    setStatus('saved');
  } catch (err) {
    if (err instanceof HttpError && err.status === 409) {
      setStatus(null);
      openConflict();
    } else if (err instanceof HttpError && err.status === 413) {
      state.rejectedText = sentText;
      setStatus('error');
      showMessage(`O texto é demasiado grande para ser gravado (máximo ${formatBytes(state.maxBodyBytes ?? 1048576)}). Reduz o texto para continuar a gravar.`, 'too-large');
    } else {
      handleFailure(err);
    }
  } finally {
    state.actionRunning = null;
  }
}

async function update() {
  const before = state.savedText;
  state.actionRunning = 'UPDATE';
  state.lastAction = Date.now();
  try {
    const res = await getBody(state.lastModified);
    onSuccess();
    if (res.changed) {
      // Só se o utilizador não escreveu entretanto; senão o POST seguinte resolve por 409.
      if (textarea.value === state.savedText && state.savedText === before && !dialog.open) {
        replaceText(res.body);
        state.savedText = res.body;
        state.lastModified = res.lastModified;
      }
    }
  } catch (err) {
    handleFailure(err);
  } finally {
    state.actionRunning = null;
  }
}

function tick() {
  if (!state.loaded || state.blocked) return;
  if (state.actionRunning !== null || dialog.open) return;
  if (Date.now() - state.lastAction < state.interval) return;

  if (textarea.value !== state.savedText) {
    if (textarea.value === state.rejectedText) return;
    save();
  } else if (!document.hidden) {
    update();
  }
}

// ---- Modal de conflito ----------------------------------------------------

function openConflict() {
  if (!dialog.open) dialog.showModal();
}

dialog.addEventListener('cancel', (event) => event.preventDefault()); // obriga a escolher

document.getElementById('conflict-override').addEventListener('click', () => {
  state.forceOverride = true;
  dialog.close();
  state.lastAction = 0; // grava já no próximo tick
  textarea.focus();
});

document.getElementById('conflict-discard').addEventListener('click', async () => {
  dialog.close();
  state.actionRunning = 'UPDATE';
  state.lastAction = Date.now();
  try {
    const res = await getBody(0);
    onSuccess();
    replaceText(res.body);
    state.savedText = res.body;
    state.lastModified = res.lastModified;
    state.forceOverride = false;
  } catch (err) {
    handleFailure(err);
  } finally {
    state.actionRunning = null;
    textarea.focus();
  }
});

// ---- Teclado e saída -------------------------------------------------------

textarea.addEventListener('keydown', (event) => {
  if (event.key !== 'Tab' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
  event.preventDefault();
  textarea.setRangeText('\t', textarea.selectionStart, textarea.selectionEnd, 'end');
});

window.addEventListener('beforeunload', (event) => {
  if (state.loaded && !state.blocked && textarea.value !== state.savedText) {
    event.preventDefault();
    event.returnValue = '';
  }
});

document.addEventListener('visibilitychange', () => {
  // Ao voltar ao separador, atualiza no próximo tick (exceto durante o recuo por 429).
  if (!document.hidden && state.interval === state.baseInterval) {
    state.lastAction = Math.min(state.lastAction, Date.now() - state.interval);
  }
});

// ---- Menu de subpáginas -----------------------------------------------------

async function loadMenu() {
  let names;
  try {
    names = await request(api('menu'), { headers: { Accept: 'application/json' } });
  } catch {
    return;
  }
  if (!Array.isArray(names) || names.length === 0) return;

  names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0));
  menuList.replaceChildren(
    ...names.map((name) => {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = `${encodedPath}/${encodeURIComponent(name)}`;
      a.textContent = name;
      li.append(a);
      return li;
    }),
  );
  zipLink.href = api('zip');
  menuDiv.hidden = false;
}

// ---- Arranque -------------------------------------------------------------

async function loadConfig() {
  try {
    const cfg = await request('/api/config', { headers: { Accept: 'application/json' } });
    if (Number.isFinite(cfg.syncIntervalMs) && cfg.syncIntervalMs > 0) state.baseInterval = state.interval = cfg.syncIntervalMs;
    if (Number.isFinite(cfg.requestTimeoutMs) && cfg.requestTimeoutMs > 0) state.timeoutMs = cfg.requestTimeoutMs;
    if (typeof cfg.appName === 'string' && cfg.appName) state.appName = cfg.appName;
    if (Number.isFinite(cfg.maxBodyBytes)) state.maxBodyBytes = cfg.maxBodyBytes;
  } catch {
    // Sem configuração usam-se os valores por omissão.
  }
}

async function firstLoad() {
  for (;;) {
    try {
      const res = await getBody(0);
      textarea.value = res.body;
      state.savedText = res.body;
      state.lastModified = res.lastModified;
      state.loaded = true;
      state.lastAction = Date.now();
      textarea.disabled = false;
      textarea.focus();
      textarea.setSelectionRange(0, 0);
      onSuccess();
      return true;
    } catch (err) {
      handleFailure(err);
      if (state.blocked) return false;
      await new Promise((r) => setTimeout(r, state.interval));
    }
  }
}

async function start() {
  if (!pagePath) {
    state.blocked = true;
    showMessage('O endereço desta página não é válido.', 'fatal');
    return;
  }
  const fallbackName = document.title || 'openpad';
  await loadConfig();
  const lastSegment = pagePath.slice(pagePath.lastIndexOf('/') + 1);
  document.title = `${lastSegment} | ${state.appName || fallbackName}`;

  if (!(await firstLoad())) return;
  loadMenu();
  setInterval(tick, TICK_MS);
}

start();
