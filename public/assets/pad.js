// Editing page: loading, near real-time sync, merges, subpages and UI.
//
// Sync model
// - Saving: about 250 ms after the last keystroke (at most 1 s while typing
//   non-stop), as a POST with the lastModified the text was based on.
// - Receiving: a Server-Sent Events stream tells the page when someone else
//   saved; the page then fetches the new text at once.
// - Fallback: while the stream is down, the page polls every SYNC_INTERVAL_MS.
// - Never two requests at the same time. Edits by two people in different
//   parts of the text are merged; overlapping edits open the conflict dialog.

import { createFiles } from './files.js';
import { merge3 } from './merge.js';

const TICK_MS = 50;
const SAVE_DEBOUNCE_MS = 250;
const SAVE_MAX_WAIT_MS = 1000;
const LIVE_SAFETY_POLL_MS = 30_000;
const MAX_BACKOFF_MS = 60_000;
const RECENT_KEY = 'openpad:recent';

const $ = (id) => document.getElementById(id);
const textarea = $('text');
const editor = textarea.parentElement;
const dialog = $('conflict');

// ---- Page path --------------------------------------------------------------

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
const segments = pagePath ? pagePath.slice(1).split('/') : [];
const encodedPath = pagePath ? pagePath.split('/').map(encodeURIComponent).join('/') : '';
if (pagePath && encodedPath !== location.pathname) {
  history.replaceState(null, '', encodedPath + location.search + location.hash);
}
const api = (kind) => `/api/${kind}${encodedPath}`;

// ---- State ------------------------------------------------------------------

const state = {
  savedText: '', // last text known to be on the server
  lastModified: 0, // server version that savedText belongs to
  actionRunning: null, // null | 'SAVE' | 'UPDATE'
  loaded: false,
  blocked: false, // permanent error (invalid path, nesting limit)
  forceOverride: false,
  rejectedText: null, // text refused with 413; not retried until it changes
  lastInputAt: 0,
  dirtySince: null,
  notBefore: 0, // no request before this time (back-off after errors)
  pollMs: 5000,
  backoffMs: 5000,
  nextPollAt: 0,
  needUpdate: false,
  versionsSeenDuringSave: [], // change notices that arrived while our own save was in flight
  live: false,
  stream: 'connecting', // 'connecting' | 'open' | 'down'
  online: true,
  timeoutMs: 10_000,
  appName: document.title || 'openpad',
  maxBodyBytes: 1_048_576,
  maxDepth: 10,
  lastSavedAt: null,
  presence: 0,
  deleting: false, // our own DELETE is in flight
  deleted: false, // the page was deleted (by us or someone else): leaving
};

// ---- HTTP -------------------------------------------------------------------

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
    if ((res.headers.get('content-type') || '').includes('application/json')) data = await res.json();
    if (!res.ok) throw new HttpError(res.status, data && data.error);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

const getBody = (lastModified) =>
  request(`${api('body')}?lastModified=${encodeURIComponent(lastModified)}`, { headers: { Accept: 'application/json' } });

function postBody(text, lastModified, force) {
  const body = new URLSearchParams({ text, lastModified: String(lastModified), force: force ? 'true' : 'false' });
  return request(api('body'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', Accept: 'application/json' },
    body,
  });
}

// ---- Indicators -------------------------------------------------------------

const SYNC_TEXT = {
  connecting: ['Connecting…', 'Connecting to the server'],
  live: ['Live', 'Live: changes from others appear instantly'],
  syncing: ['Syncing…', 'Receiving changes'],
  polling: ['Reconnecting…', 'Live updates paused, checking for changes every few seconds'],
  offline: ['Offline', 'Cannot reach the server, retrying'],
};

const SAVE_TEXT = {
  saved: ['Saved', 'All changes saved'],
  pending: ['Unsaved', 'Changes waiting to be saved'],
  saving: ['Saving…', 'Saving your changes'],
  error: ['Not saved', 'Could not save, retrying automatically'],
  toolarge: ['Too large', 'The text is too large to be saved'],
};

let syncShown = 'connecting';
let syncHoldUntil = 0;
let syncTimer = null;

function baseSyncState() {
  if (!state.online) return 'offline';
  if (state.stream === 'open') return 'live';
  return state.stream === 'connecting' ? 'connecting' : 'polling';
}

function setSync(kind) {
  syncShown = kind;
  const el = $('sync');
  if (el.dataset.state === kind) return;
  el.dataset.state = kind;
  $('sync-label').textContent = SYNC_TEXT[kind][0];
  el.title = SYNC_TEXT[kind][1];
}

/** Shows the base sync state, keeping a "syncing" pulse on screen long enough to be seen. */
function refreshSync() {
  const wait = syncHoldUntil - Date.now();
  if (syncShown === 'syncing' && wait > 0) {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(refreshSync, wait);
    return;
  }
  setSync(baseSyncState());
}

function pulseSync() {
  syncHoldUntil = Date.now() + 700;
  setSync('syncing');
}

function setSave(kind) {
  const el = $('save');
  if (el.dataset.state === kind) return;
  el.dataset.state = kind;
  $('save-label').textContent = SAVE_TEXT[kind][0];
  el.title = SAVE_TEXT[kind][1];
}

function refreshSave() {
  if (state.rejectedText !== null && textarea.value === state.rejectedText) return setSave('toolarge');
  if (state.actionRunning === 'SAVE') return setSave('saving');
  if (textarea.value !== state.savedText) {
    return setSave($('save').dataset.state === 'error' ? 'error' : 'pending');
  }
  setSave('saved');
}

function setPresence(count) {
  const el = $('presence');
  state.presence = count;
  el.hidden = !(state.live && count > 0);
  $('presence-count').textContent = String(count);
  el.title = count === 1 ? 'Only you are on this page' : `${count} people on this page`;
}

function setProgress(on) {
  $('progress').classList.toggle('active', on);
}

// ---- Toasts and banner ------------------------------------------------------

function toast(text, { kind = 'info', ms = 2600 } = {}) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.dataset.kind = kind;
  if (kind === 'ok') {
    el.innerHTML = '<svg class="icon" viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"/></svg>';
  }
  el.append(document.createTextNode(text));
  $('toasts').append(el);
  setTimeout(() => {
    el.classList.add('leaving');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }, ms);
}

function showBanner(text) {
  $('message').textContent = text;
  $('message').hidden = false;
}

function formatBytes(n) {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1).replace('.0', '')} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

// ---- Status bar -------------------------------------------------------------

const numberFormat = new Intl.NumberFormat('en');

function updateStats() {
  const text = textarea.value;
  const words = (text.match(/\S+/g) || []).length;
  const lines = text === '' ? 0 : text.split('\n').length;
  $('stats').textContent = `${numberFormat.format(words)} words · ${numberFormat.format(text.length)} characters · ${numberFormat.format(lines)} lines`;
}

function updateLastSaved() {
  const el = $('last-saved');
  if (!state.lastSavedAt) {
    el.textContent = state.lastModified ? `Last change ${ago(state.lastModified)}` : 'New page';
    return;
  }
  el.textContent = `Saved ${ago(state.lastSavedAt)}`;
}

function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(ts).toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric' });
}

// ---- Applying remote text (keeps the caret and scroll position) -------------

function mapOffset(pos, prefix, oldEnd, newEnd) {
  if (pos <= prefix) return pos;
  if (pos >= oldEnd) return pos - oldEnd + newEnd;
  return newEnd;
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
  updateStats();
  editor.classList.remove('remote-flash');
  void editor.offsetWidth;
  editor.classList.add('remote-flash');
}

/** Folds the server's text into the editor, merging unsaved local edits when possible. */
function absorbRemote(body, lastModified) {
  const local = textarea.value;
  if (local === state.savedText) {
    replaceText(body);
  } else {
    const merged = merge3(state.savedText, local, body);
    if (!merged.ok) return false;
    replaceText(merged.text);
    state.dirtySince = state.dirtySince ?? Date.now();
  }
  state.savedText = body;
  state.lastModified = lastModified;
  return true;
}

// ---- Errors -------------------------------------------------------------------

function isNetworkError(err) {
  return !(err instanceof HttpError) || err.status >= 500;
}

function handleFailure(err) {
  const now = Date.now();
  if (err instanceof HttpError) {
    if (err.status === 410) return pageDeleted(false); // deleted while we were away
    if (err.code === 'nesting-limit-reached') return block(`This page is nested too deeply (the limit is ${state.maxDepth} levels), so it can't be edited.`);
    if (err.code === 'invalid-path') return block("This address isn't a valid page.");
    if (err.status === 429) {
      state.backoffMs = Math.min(state.backoffMs * 2, MAX_BACKOFF_MS);
      state.notBefore = now + state.backoffMs;
      if (textarea.value !== state.savedText) setSave('error');
      return;
    }
  }
  if (isNetworkError(err)) {
    state.online = false;
    refreshSync();
  }
  state.notBefore = now + state.backoffMs;
  if (textarea.value !== state.savedText) setSave('error');
}

function succeeded() {
  state.backoffMs = state.pollMs;
  state.notBefore = 0;
  if (!state.online) {
    state.online = true;
    refreshSync();
  }
}

function block(message) {
  state.blocked = true;
  textarea.disabled = true;
  editor.classList.add('ready');
  showBanner(message);
  setSave('error');
  setProgress(false);
}

// ---- Save and update ----------------------------------------------------------

async function save() {
  const sent = textarea.value;
  state.actionRunning = 'SAVE';
  setSave('saving');
  try {
    const lastModified = await postBody(sent, state.lastModified, state.forceOverride);
    succeeded();
    state.lastModified = Number(lastModified);
    state.savedText = sent; // the text that was sent, not the textarea's current value
    state.forceOverride = false;
    state.rejectedText = null;
    state.lastSavedAt = Date.now();
    state.dirtySince = textarea.value !== sent ? state.lastInputAt : null;
    $('message').hidden = !state.blocked;
    updateLastSaved();
  } catch (err) {
    if (err instanceof HttpError && err.status === 409) {
      await resolveConflict();
    } else if (err instanceof HttpError && err.status === 413) {
      succeeded();
      state.rejectedText = sent;
      toast(`This text is too large to save (limit ${formatBytes(state.maxBodyBytes)}). Shorten it to resume saving.`, { kind: 'error', ms: 5000 });
    } else {
      handleFailure(err);
    }
  } finally {
    state.actionRunning = null;
    // Notices for versions other than the one we just wrote come from someone else.
    if (state.versionsSeenDuringSave.some((v) => v !== state.lastModified)) state.needUpdate = true;
    state.versionsSeenDuringSave = [];
    refreshSave();
  }
}

/** After a 409: fetch the latest text and merge; only overlapping edits reach the dialog. */
async function resolveConflict() {
  try {
    const res = await getBody(0);
    succeeded();
    pulseSync();
    if (absorbRemote(res.body, res.lastModified)) {
      state.dirtySince = textarea.value !== state.savedText ? 0 : null; // save the merge right away
      refreshSync();
      return;
    }
    openConflict();
  } catch (err) {
    handleFailure(err);
  }
}

async function update() {
  state.actionRunning = 'UPDATE';
  const fromEvent = state.needUpdate;
  state.needUpdate = false;
  if (fromEvent) pulseSync();
  try {
    const res = await getBody(state.lastModified);
    succeeded();
    if (res.changed && (res.lastModified !== state.lastModified || res.body !== state.savedText)) {
      // Overlapping unsaved edits are left alone: the next save gets 409 and resolves it.
      absorbRemote(res.body, res.lastModified);
      updateLastSaved();
    }
  } catch (err) {
    handleFailure(err);
  } finally {
    state.actionRunning = null;
    state.nextPollAt = Date.now() + (state.live ? LIVE_SAFETY_POLL_MS : state.pollMs);
    refreshSync();
    refreshSave();
  }
}

function tick() {
  if (!state.loaded || state.blocked || state.deleting || state.actionRunning !== null || dialog.open) return;
  const now = Date.now();
  if (now < state.notBefore) return;

  const text = textarea.value;
  if (text !== state.savedText && text !== state.rejectedText) {
    if (state.dirtySince === null) state.dirtySince = now;
    const due = state.forceOverride ? 0 : Math.min(state.lastInputAt + SAVE_DEBOUNCE_MS, state.dirtySince + SAVE_MAX_WAIT_MS);
    if (now >= due) save();
    return;
  }
  if (document.hidden) return;
  if (state.needUpdate || now >= state.nextPollAt) update();
}

// ---- Live updates (Server-Sent Events) -----------------------------------

let events = null;
let reconnectTimer = null;
let files = null; // floating shared files (files.js)
const hasEventSource = typeof EventSource !== 'undefined';

function streamClosed() {
  return hasEventSource && (!events || events.readyState === EventSource.CLOSED);
}

function connectEvents() {
  if (state.deleted) return;
  if (!hasEventSource) {
    state.stream = 'down';
    refreshSync();
    return;
  }
  clearTimeout(reconnectTimer);
  if (events) events.close();
  events = new EventSource(api('events'));
  files?.attach(events);

  const onVersion = (e) => {
    try {
      const { lastModified } = JSON.parse(e.data);
      // While our own save is in flight its notice can arrive first: decide once the save returns.
      if (state.actionRunning === 'SAVE') state.versionsSeenDuringSave.push(lastModified);
      else if (lastModified !== state.lastModified) state.needUpdate = true;
    } catch {
      // ignore malformed frames
    }
  };

  events.addEventListener('open', () => {
    state.live = true;
    state.stream = 'open';
    state.online = true;
    state.needUpdate = true; // catch up with anything missed while disconnected
    refreshSync();
  });
  events.addEventListener('hello', onVersion);
  events.addEventListener('change', onVersion);
  events.addEventListener('presence', (e) => {
    try {
      setPresence(JSON.parse(e.data).count);
    } catch {
      // ignore
    }
  });
  // Someone deleted the page: the server sends this last and closes the stream.
  events.addEventListener('deleted', () => pageDeleted(state.deleting));
  events.addEventListener('error', () => {
    if (state.deleted) return;
    state.live = false;
    state.stream = 'down';
    setPresence(0);
    state.nextPollAt = Math.min(state.nextPollAt, Date.now() + state.pollMs);
    refreshSync();
    // The browser retries on its own unless the server refused the stream.
    if (events.readyState === EventSource.CLOSED) reconnectTimer = setTimeout(connectEvents, 5000 + Math.random() * 3000);
  });
}

// ---- Conflict dialog ----------------------------------------------------------

function openConflict() {
  setSave('pending');
  if (!dialog.open) dialog.showModal();
}

dialog.addEventListener('cancel', (event) => event.preventDefault()); // a choice is required

$('conflict-override').addEventListener('click', () => {
  state.forceOverride = true;
  dialog.close();
  textarea.focus();
});

$('conflict-discard').addEventListener('click', async () => {
  dialog.close();
  state.actionRunning = 'UPDATE';
  try {
    const res = await getBody(0);
    succeeded();
    replaceText(res.body);
    state.savedText = res.body;
    state.lastModified = res.lastModified;
    state.forceOverride = false;
    state.dirtySince = null;
  } catch (err) {
    handleFailure(err);
  } finally {
    state.actionRunning = null;
    refreshSave();
    textarea.focus();
  }
});

$('conflict-copy').addEventListener('click', () => copyText(textarea.value, 'Your text was copied'));

// ---- Editor events ------------------------------------------------------------

function onInput() {
  const now = Date.now();
  state.lastInputAt = now;
  if (state.dirtySince === null) state.dirtySince = now;
  updateStats();
  if (state.actionRunning !== 'SAVE') refreshSave();
}

textarea.addEventListener('input', onInput);

textarea.addEventListener('keydown', (event) => {
  if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
    event.preventDefault();
    textarea.setRangeText('\t', textarea.selectionStart, textarea.selectionEnd, 'end');
    onInput();
  }
});

document.addEventListener('keydown', (event) => {
  // Ctrl/Cmd+S saves now instead of opening the browser's "save page" dialog.
  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 's') {
    event.preventDefault();
    if (textarea.value !== state.savedText) state.dirtySince = 0;
    else toast('Already saved', { kind: 'ok', ms: 1400 });
  }
  if (event.key === 'Escape') closeMenu();
});

window.addEventListener('beforeunload', (event) => {
  if (state.loaded && !state.blocked && textarea.value !== state.savedText) {
    event.preventDefault();
    event.returnValue = '';
  }
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    if (streamClosed()) connectEvents();
    if (state.backoffMs === state.pollMs) state.nextPollAt = Math.min(state.nextPollAt, Date.now());
  }
});

window.addEventListener('online', () => {
  state.notBefore = 0;
  if (streamClosed()) connectEvents();
});

// ---- Breadcrumbs ----------------------------------------------------------------

function renderCrumbs() {
  const nav = $('crumbs');
  const parts = [];
  segments.forEach((segment, index) => {
    const sep = document.createElement('span');
    sep.className = 'sep';
    sep.textContent = '/';
    const a = document.createElement('a');
    a.href = '/' + segments.slice(0, index + 1).map(encodeURIComponent).join('/');
    a.textContent = segment;
    a.style.animationDelay = `${0.1 + index * 0.05}s`;
    if (index === segments.length - 1) a.setAttribute('aria-current', 'page');
    parts.push(sep, a);
  });
  nav.replaceChildren(...parts);
}

// ---- Subpages sidebar -------------------------------------------------------

const workspace = $('workspace');
const SIDEBAR_KEY = 'openpad:sidebar';

function setSidebar(open, remember = false) {
  workspace.classList.toggle('sidebar-open', open);
  $('sidebar-toggle').setAttribute('aria-expanded', String(open));
  $('scrim').hidden = !open || !window.matchMedia('(max-width: 760px)').matches;
  if (remember) {
    try {
      localStorage.setItem(SIDEBAR_KEY, open ? 'open' : 'closed');
    } catch {
      // ignore
    }
  }
}

function sidebarPreference() {
  try {
    return localStorage.getItem(SIDEBAR_KEY);
  } catch {
    return null;
  }
}

$('sidebar-toggle').addEventListener('click', () => {
  const open = !workspace.classList.contains('sidebar-open');
  setSidebar(open, true);
  if (open) loadMenu();
});
$('scrim').addEventListener('click', () => setSidebar(false));

let menuNames = [];

function pageIcon() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'icon page-icon');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z', 'M14 3v5h5', 'M9 13h6', 'M9 17h4']) {
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

async function loadMenu({ initial = false } = {}) {
  let names;
  try {
    names = await request(api('menu'), { headers: { Accept: 'application/json' } });
  } catch {
    return;
  }
  if (!Array.isArray(names)) return;
  names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0));

  const changed = names.join('\n') !== menuNames.join('\n');
  menuNames = names;
  $('sub-count').textContent = String(names.length);
  $('sub-empty').hidden = names.length > 0;
  if (changed) {
    $('menu').replaceChildren(
      ...names.map((name, index) => {
        const li = document.createElement('li');
        li.style.animationDelay = `${index * 0.03}s`;
        const a = document.createElement('a');
        a.href = `${encodedPath}/${encodeURIComponent(name)}`;
        a.append(pageIcon(), document.createTextNode(name));
        li.append(a);
        return li;
      }),
    );
  }

  if (initial) {
    const pref = sidebarPreference();
    const wide = window.matchMedia('(min-width: 761px)').matches;
    setSidebar(wide && pref !== 'closed' && (names.length > 0 || pref === 'open'));
  }
}

$('sub-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const parts = $('sub-name').value.split('/').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return;
  location.href = `${encodedPath}/${parts.map(encodeURIComponent).join('/')}`;
});

// ---- Menu -------------------------------------------------------------------------

const menuBtn = $('menu-btn');
const menuPop = $('menu-pop');

function closeMenu() {
  if (menuPop.hidden) return;
  menuPop.hidden = true;
  menuBtn.setAttribute('aria-expanded', 'false');
}

menuBtn.addEventListener('click', (event) => {
  event.stopPropagation();
  const open = menuPop.hidden;
  menuPop.hidden = !open;
  menuBtn.setAttribute('aria-expanded', String(open));
  if (open) menuPop.querySelector('.popover-item')?.focus();
});

document.addEventListener('click', (event) => {
  if (!menuPop.hidden && !menuPop.contains(event.target)) closeMenu();
});

async function copyText(text, done) {
  try {
    await navigator.clipboard.writeText(text);
    toast(done, { kind: 'ok' });
  } catch {
    window.prompt('Copy this:', text);
  }
}

$('act-copy').addEventListener('click', () => {
  closeMenu();
  copyText((state.publicOrigin || location.origin) + encodedPath, 'Link copied to clipboard');
});

$('act-txt').addEventListener('click', () => {
  closeMenu();
  const blob = new Blob([textarea.value], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${segments[segments.length - 1] || 'page'}.txt`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

$('act-zip').href = api('zip');
$('act-zip').addEventListener('click', () => closeMenu());

function readPref(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writePref(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

function syncMonoItem() {
  $('act-mono').setAttribute('aria-checked', String(document.documentElement.dataset.mono === '1'));
}

$('act-mono').addEventListener('click', () => {
  const on = document.documentElement.dataset.mono !== '1';
  if (on) document.documentElement.dataset.mono = '1';
  else delete document.documentElement.dataset.mono;
  writePref('openpad:mono', on ? '1' : null);
  syncMonoItem();
});

const THEMES = ['system', 'light', 'dark'];

function currentTheme() {
  const t = document.documentElement.dataset.theme;
  return t === 'light' || t === 'dark' ? t : 'system';
}

function syncThemeItem() {
  const t = currentTheme();
  $('theme-name').textContent = t[0].toUpperCase() + t.slice(1);
}

$('act-theme').addEventListener('click', () => {
  const next = THEMES[(THEMES.indexOf(currentTheme()) + 1) % THEMES.length];
  if (next === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = next;
  writePref('openpad:theme', next === 'system' ? null : next);
  syncThemeItem();
});

// ---- Delete the page for everyone ---------------------------------------------------

const deleteDialog = $('delete-dialog');
const REDIRECT_AFTER_MS = 3000;

$('act-delete').addEventListener('click', () => {
  closeMenu();
  $('delete-path').textContent = pagePath;
  const others = Math.max(0, state.presence - 1);
  $('delete-others').textContent =
    !state.live || others === 0
      ? 'Nobody else is on this page right now.'
      : `${others === 1 ? '1 other person is' : `${others} other people are`} on this page right now. They will see it disappear and be sent to the home page.`;
  deleteDialog.showModal();
  $('delete-cancel').focus();
});

$('delete-cancel').addEventListener('click', () => deleteDialog.close());

$('delete-confirm').addEventListener('click', async () => {
  const button = $('delete-confirm');
  button.disabled = true;
  state.deleting = true; // no saves from here on
  try {
    await request(api('body'), { method: 'DELETE', headers: { Accept: 'application/json' } });
    pageDeleted(true);
  } catch (err) {
    state.deleting = false;
    if (err instanceof HttpError && err.status === 410) return pageDeleted(false);
    toast(isNetworkError(err) ? 'Could not reach the server. The page was not deleted.' : 'Could not delete the page. Try again.', { kind: 'error', ms: 4000 });
  } finally {
    button.disabled = false;
  }
});

function forgetRecent() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    if (Array.isArray(list)) localStorage.setItem(RECENT_KEY, JSON.stringify(list.filter((r) => r && r.path !== pagePath)));
  } catch {
    // ignore
  }
}

/** Copies the visible text into words that can fall away (a textarea can't animate its letters). */
function crumbleText() {
  if (!textarea.value.trim()) return;
  const rect = textarea.getBoundingClientRect();
  const cs = getComputedStyle(textarea);
  const ghost = document.createElement('div');
  ghost.className = 'crumble';
  ghost.setAttribute('aria-hidden', 'true');
  for (const prop of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'tabSize', 'color']) {
    ghost.style[prop] = cs[prop];
  }
  Object.assign(ghost.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  const inner = document.createElement('div');
  inner.style.transform = `translateY(${-textarea.scrollTop}px)`;
  let words = 0;
  for (const token of textarea.value.split(/(\s+)/)) {
    if (!token) continue;
    if (/^\s+$/.test(token)) {
      inner.append(token);
      continue;
    }
    if (++words > 4000) break;
    const span = document.createElement('span');
    span.textContent = token;
    inner.append(span);
  }
  ghost.append(inner);
  document.body.append(ghost);

  // Only the words in view fall; lower lines go first, like a page crumbling.
  const top = textarea.scrollTop;
  const height = rect.height;
  for (const span of inner.children) {
    const y = span.offsetTop - top;
    if (y < -40 || y > height + 40) {
      span.style.visibility = 'hidden';
      continue;
    }
    const fromBottom = 1 - Math.min(1, Math.max(0, y / height));
    span.style.setProperty('--d', `${(fromBottom * 0.45 + Math.random() * 0.3).toFixed(3)}s`);
    span.style.setProperty('--x', `${Math.round((Math.random() - 0.5) * 140)}px`);
    span.style.setProperty('--r', `${Math.round((Math.random() - 0.5) * 100)}deg`);
    span.classList.add('fall');
  }
}

function pageDeleted(byMe) {
  if (state.deleted) return;
  state.deleted = true;
  state.blocked = true;
  state.deleting = false;
  clearTimeout(reconnectTimer);
  if (events) {
    events.close();
    events = null;
  }
  closeMenu();
  if (dialog.open) dialog.close();
  if (deleteDialog.open) deleteDialog.close();
  setPresence(0);
  forgetRecent();

  crumbleText();
  textarea.disabled = true;
  document.body.classList.add('page-deleting');
  document.querySelectorAll('#files-layer .file-win').forEach((win) => {
    win.style.setProperty('--d', `${(Math.random() * 0.35).toFixed(3)}s`);
    win.style.setProperty('--r', `${Math.round((Math.random() - 0.5) * 50)}deg`);
  });

  $('deleted-text').textContent = byMe
    ? 'You deleted it for everyone. Taking you to the home page…'
    : 'Someone deleted it while you were here. Taking you to the home page…';
  const overlay = $('deleted');
  setTimeout(() => {
    overlay.hidden = false;
    requestAnimationFrame(() => overlay.classList.add('show'));
    $('deleted-home').focus();
    let left = Math.round(REDIRECT_AFTER_MS / 1000);
    $('deleted-seconds').textContent = String(left);
    const timer = setInterval(() => {
      left -= 1;
      $('deleted-seconds').textContent = String(Math.max(left, 0));
      if (left <= 0) {
        clearInterval(timer);
        location.replace('/');
      }
    }, 1000);
  }, 900);
}

$('deleted-home').addEventListener('click', (event) => {
  event.preventDefault();
  location.replace('/');
});

// ---- Recently opened (this browser only) ----------------------------------------

function rememberRecent() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    const next = [{ path: pagePath, at: Date.now() }, ...(Array.isArray(list) ? list : []).filter((r) => r && r.path !== pagePath)];
    localStorage.setItem(RECENT_KEY, JSON.stringify(next.slice(0, 12)));
  } catch {
    // ignore
  }
}

// ---- Startup ----------------------------------------------------------------------

async function loadConfig() {
  try {
    const cfg = await request('/api/config', { headers: { Accept: 'application/json' } });
    if (Number.isFinite(cfg.syncIntervalMs) && cfg.syncIntervalMs > 0) state.pollMs = state.backoffMs = cfg.syncIntervalMs;
    if (Number.isFinite(cfg.requestTimeoutMs) && cfg.requestTimeoutMs > 0) state.timeoutMs = cfg.requestTimeoutMs;
    if (typeof cfg.appName === 'string' && cfg.appName) state.appName = cfg.appName;
    if (Number.isFinite(cfg.maxBodyBytes)) state.maxBodyBytes = cfg.maxBodyBytes;
    if (Number.isFinite(cfg.maxDepth)) state.maxDepth = cfg.maxDepth;
    if (typeof cfg.publicAddress === 'string' && /^https?:\/\//.test(cfg.publicAddress)) state.publicOrigin = cfg.publicAddress;
    files?.setLimits(cfg);
  } catch {
    // Defaults are used.
  }
}

async function firstLoad() {
  for (;;) {
    try {
      const res = await getBody(0);
      succeeded();
      textarea.value = res.body;
      state.savedText = res.body;
      state.lastModified = res.lastModified;
      state.loaded = true;
      state.nextPollAt = Date.now() + state.pollMs;
      textarea.disabled = false;
      editor.classList.add('ready');
      textarea.focus();
      textarea.setSelectionRange(0, 0);
      updateStats();
      updateLastSaved();
      refreshSave();
      return true;
    } catch (err) {
      handleFailure(err);
      if (state.blocked) return false;
      await new Promise((r) => setTimeout(r, state.backoffMs));
    }
  }
}

async function start() {
  syncMonoItem();
  syncThemeItem();
  if (!pagePath) {
    block("This address isn't a valid page.");
    return;
  }
  renderCrumbs();
  setProgress(true);
  files = createFiles({ encodedPath, request, toast, formatBytes });
  await loadConfig();
  document.title = `${segments[segments.length - 1]} | ${state.appName}`;

  const ok = await firstLoad();
  setProgress(false);
  if (!ok) return;

  rememberRecent();
  files.refresh();
  connectEvents();
  loadMenu({ initial: true });
  setInterval(tick, TICK_MS);
  setInterval(updateLastSaved, 5000);
  setInterval(() => {
    if (!document.hidden && workspace.classList.contains('sidebar-open')) loadMenu();
  }, 20_000);
}

start();
