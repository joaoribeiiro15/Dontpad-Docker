// Shared files that float over the page.
//
// - Drop files anywhere on the page, paste them, or use the paperclip button.
// - Each file becomes a floating window that everyone on the page sees appear,
//   and anyone can drag it; others watch it move in real time.
// - Images get a lower-quality preview made in the browser (at most 1280 px), shown
//   at once on the page; Download always returns the original file.
// - The server keeps files in memory only: they expire, and a restart forgets them.

const CARD_W = 280;
const PREVIEW_MAX_SIDE = 1280;
const MOVE_INTERVAL_MS = 60;
const MAX_FILES_PER_DROP = 10;
const RASTER_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg|ico|heic|heif)$/i;
const KEEP_ORIGINAL_AS_PREVIEW = new Set(['image/gif']); // keep animations when small enough

const SVG_NS = 'http://www.w3.org/2000/svg';

function icon(paths, cls = 'icon') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}

const ICONS = {
  file: ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z', 'M14 3v5h5'],
  image: ['M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z', 'M3 16l5-5 4 4 3-3 6 6', 'M15.5 9.5h.01'],
  close: ['M6 6l12 12', 'M18 6 6 18'],
  chevron: ['m6 9 6 6 6-6'],
  download: ['M12 4v11', 'm7 10 5 5 5-5', 'M5 20h14'],
  expand: ['M15 3h6v6', 'M9 21H3v-6', 'M21 3l-7 7', 'M3 21l7-7'],
  clock: ['M12 7v5l3 2', 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z'],
};

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function randomToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
}

function extension(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 && name.length - dot <= 6 ? name.slice(dot + 1).toUpperCase() : 'FILE';
}

function isImage(file) {
  return (file.type || '').startsWith('image/') || RASTER_EXT.test(file.name || '');
}

function untilLabel(ts) {
  const s = Math.max(0, Math.round((ts - Date.now()) / 1000));
  if (s < 60) return 'Expires in under a minute';
  const m = Math.round(s / 60);
  if (m < 60) return `Expires in ${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `Expires in ${h} h ${rest} min` : `Expires in ${h} h`;
}

/** Makes a lower-quality preview of an image in the browser. Resolves to null when it can't. */
async function makePreview(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    let w = img.naturalWidth;
    let h = img.naturalHeight;
    if (!w || !h) {
      w = 1024; // SVG without intrinsic size
      h = 768;
    }
    const scale = Math.min(1, PREVIEW_MAX_SIDE / Math.max(w, h));
    const pw = Math.max(1, Math.round(w * scale));
    const ph = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement('canvas');
    canvas.width = pw;
    canvas.height = ph;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, pw, ph);

    const encode = (type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));
    let blob = await encode('image/webp', 0.78);
    if (!blob || blob.type !== 'image/webp') {
      // Browsers without WebP encoding: JPEG on a white background.
      ctx.globalCompositeOperation = 'destination-over';
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, pw, ph);
      blob = await encode('image/jpeg', 0.82);
    }
    if (!blob) return null;
    return { blob, type: blob.type, width: pw, height: ph, originalWidth: img.naturalWidth || null, originalHeight: img.naturalHeight || null };
  } catch {
    return null; // a format this browser cannot decode: shown as a regular file
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function createFiles({ encodedPath, request, toast, formatBytes }) {
  const layer = document.getElementById('files-layer');
  const overlay = document.getElementById('drop-overlay');
  const landing = document.getElementById('drop-landing');
  const lightbox = document.getElementById('lightbox');
  const clientId = randomToken();
  const windows = new Map(); // id -> win
  const pendingUploads = new Map(); // token -> placeholder win
  const limits = { maxFileBytes: 10 * 1024 * 1024, maxFilesPerPage: 20 };
  let topZ = 0;

  const filesUrl = `/api/files${encodedPath}`;

  // ---- Geometry (positions are shared as 0..1 fractions of the free space) --

  function cardWidth() {
    return Math.min(CARD_W, Math.max(200, layer.clientWidth - 16));
  }

  function bounds(win) {
    return { W: layer.clientWidth, H: layer.clientHeight, w: win.el.offsetWidth || cardWidth(), h: win.el.offsetHeight || 120 };
  }

  function place(win, glide = false) {
    const { W, H, w, h } = bounds(win);
    const left = win.file.x * Math.max(0, W - w);
    const top = win.file.y * Math.max(0, H - h);
    win.el.classList.toggle('glide', glide);
    win.el.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
    win.el.style.zIndex = String(win.file.z || 1);
    topZ = Math.max(topZ, win.file.z || 0);
  }

  function fractionsAt(clientX, clientY, w = cardWidth(), h = 160) {
    const rect = layer.getBoundingClientRect();
    const free = (size, room) => Math.max(1, room - size);
    const x = (clientX - rect.left - w / 2) / free(w, rect.width);
    const y = (clientY - rect.top - 24) / free(h, rect.height);
    return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
  }

  window.addEventListener('resize', () => {
    const w = `${cardWidth()}px`;
    for (const win of windows.values()) {
      win.el.style.width = w;
      place(win);
    }
  });

  // ---- Window element ----------------------------------------------------------

  function buildWindow(file, { local = false } = {}) {
    const root = el('div', 'file-win');
    root.style.width = `${cardWidth()}px`;
    const inner = el('div', 'file-inner');
    inner.style.setProperty('--float-delay', `${(Math.random() * 3).toFixed(2)}s`);
    root.append(inner);

    const head = el('div', 'file-head');
    const kind = el('span', 'file-kind');
    kind.append(icon(file.preview || (local && file.localPreview) ? ICONS.image : ICONS.file));
    const name = el('span', 'file-name', file.name);
    name.title = file.name;
    const collapse = el('button', 'file-btn file-collapse');
    collapse.type = 'button';
    collapse.title = 'Minimise';
    collapse.setAttribute('aria-label', 'Minimise');
    collapse.append(icon(ICONS.chevron));
    const close = el('button', 'file-btn file-close');
    close.type = 'button';
    close.title = 'Remove for everyone';
    close.setAttribute('aria-label', 'Remove for everyone');
    close.append(icon(ICONS.close));
    head.append(kind, name, collapse, close);

    const bodyWrap = el('div', 'file-body-wrap');
    const body = el('div', 'file-body');
    bodyWrap.append(body);

    const media = el('div', 'file-media');
    body.append(media);

    const meta = el('div', 'file-meta');
    const metaMain = el('span', 'file-size');
    const metaExpiry = el('span', 'file-expiry');
    meta.append(metaMain, metaExpiry);

    const progress = el('div', 'file-progress');
    const bar = el('span');
    progress.append(bar);

    const actions = el('div', 'file-actions');
    const download = el('a', 'file-download');
    const downloadLabel = el('span', 'label', 'Download');
    download.append(icon(ICONS.download), downloadLabel);
    download.setAttribute('download', file.name);
    actions.append(download);

    body.append(meta, progress, actions);
    inner.append(head, bodyWrap);

    const win = {
      id: file.id,
      file,
      el: root,
      inner,
      head,
      name,
      media,
      metaMain,
      metaExpiry,
      progress,
      bar,
      download,
      downloadLabel,
      close,
      collapse,
      collapsed: false,
      dragging: false,
    };
    renderMedia(win);
    renderMeta(win);
    wireWindow(win);
    return win;
  }

  function renderMedia(win) {
    const { file, media } = win;
    media.replaceChildren();
    const src = file.localPreview || (file.preview && file.id ? `/api/file/${file.id}/preview` : null);
    if (src) {
      const thumb = el('button', 'file-thumb');
      thumb.type = 'button';
      thumb.title = 'View larger';
      const img = document.createElement('img');
      img.alt = file.name;
      img.draggable = false;
      img.decoding = 'async';
      const pw = file.previewWidth || file.width;
      const ph = file.previewHeight || file.height;
      if (pw && ph) {
        img.width = pw;
        img.height = ph;
        thumb.style.aspectRatio = `${pw} / ${ph}`;
      }
      img.addEventListener('load', () => {
        thumb.classList.add('loaded');
        if (!win.dragging) place(win);
      });
      img.src = src;
      const zoom = el('span', 'file-zoom');
      zoom.append(icon(ICONS.expand));
      thumb.append(img, zoom);
      // Pointer clicks are handled by the drag code (it captures the pointer); this covers the keyboard.
      thumb.addEventListener('click', (e) => {
        if (e.detail === 0) openLightbox(win);
      });
      media.append(thumb);
      win.thumb = thumb;
    } else {
      const badge = el('div', 'file-badge');
      badge.append(icon(ICONS.file, 'icon badge-icon'), el('span', 'badge-ext', extension(file.name)));
      media.append(badge);
    }
  }

  function renderMeta(win) {
    const { file } = win;
    const dims = file.width && file.height ? ` · ${file.width} × ${file.height}` : '';
    win.metaMain.textContent = `${formatBytes(file.size)}${dims}`;
    win.metaExpiry.textContent = file.expiresAt ? untilLabel(file.expiresAt) : '';
    win.metaExpiry.title = 'Temporary: kept in memory only and gone after a server restart';
    const hasImage = Boolean(file.preview || file.localPreview);
    win.downloadLabel.textContent = hasImage ? 'Download original' : 'Download';
    win.download.title = hasImage ? 'Download the original, full-quality image' : `Download ${file.name}`;
    if (file.id && !file.uploading) {
      win.download.href = `/api/file/${file.id}`;
      win.download.removeAttribute('aria-disabled');
    } else {
      win.download.removeAttribute('href');
      win.download.setAttribute('aria-disabled', 'true');
    }
  }

  function wireWindow(win) {
    // Collapse (local to this browser).
    win.collapse.addEventListener('click', () => {
      win.collapsed = !win.collapsed;
      win.el.classList.toggle('collapsed', win.collapsed);
      win.collapse.title = win.collapsed ? 'Expand' : 'Minimise';
      setTimeout(() => place(win), 260);
    });

    // Remove for everyone: first click arms, second click confirms.
    win.close.addEventListener('click', async () => {
      if (win.file.uploading) {
        win.xhr?.abort();
        return;
      }
      if (!win.close.classList.contains('armed')) {
        win.close.classList.add('armed');
        win.close.title = 'Click again to remove for everyone';
        clearTimeout(win.armTimer);
        win.armTimer = setTimeout(() => {
          win.close.classList.remove('armed');
          win.close.title = 'Remove for everyone';
        }, 2500);
        return;
      }
      removeWindow(win.id);
      try {
        await request(`/api/file/${win.id}`, { method: 'DELETE', headers: { Accept: 'application/json' } });
      } catch {
        // already gone, or the server is down: it disappears with the server anyway
      }
    });

    // Drag from anywhere on the window except its buttons and links.
    win.el.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.target.closest('.file-btn, .file-download')) return;
      const onThumb = Boolean(event.target.closest('.file-thumb'));
      if (!win.file.id || win.file.uploading) {
        if (onThumb) openLightbox(win);
        return;
      }
      event.preventDefault();
      const rect = win.el.getBoundingClientRect();
      const start = { x: event.clientX, y: event.clientY, dx: event.clientX - rect.left, dy: event.clientY - rect.top };
      win.dragging = true;
      win.moved = false;
      win.el.setPointerCapture(event.pointerId);
      win.el.classList.add('dragging');
      win.file.z = ++topZ;
      place(win);
      sendMove(win, true);

      const onMove = (e) => {
        if (!win.moved && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 4) return;
        win.moved = true;
        const { W, H, w, h } = bounds(win);
        const lr = layer.getBoundingClientRect();
        const left = Math.min(Math.max(0, e.clientX - lr.left - start.dx), Math.max(0, W - w));
        const top = Math.min(Math.max(0, e.clientY - lr.top - start.dy), Math.max(0, H - h));
        win.file.x = W > w ? left / (W - w) : 0;
        win.file.y = H > h ? top / (H - h) : 0;
        place(win);
        sendMove(win);
      };
      const onUp = () => {
        win.el.removeEventListener('pointermove', onMove);
        win.el.removeEventListener('pointerup', onUp);
        win.el.removeEventListener('pointercancel', onUp);
        win.el.classList.remove('dragging');
        win.dragging = false;
        if (win.moved) sendMove(win, false, true);
        else if (onThumb) openLightbox(win); // a click on the picture, not a drag
        win.moved = false;
      };
      win.el.addEventListener('pointermove', onMove);
      win.el.addEventListener('pointerup', onUp);
      win.el.addEventListener('pointercancel', onUp);
    });
  }

  // Coalesced position updates: at most one request in flight per window.
  function sendMove(win, front = false, final = false) {
    win.pendingMove = { x: win.file.x, y: win.file.y, front: front || Boolean(win.pendingMove?.front), by: clientId };
    if (win.moveInFlight) return;
    const wait = final ? 0 : Math.max(0, MOVE_INTERVAL_MS - (Date.now() - (win.lastMoveAt || 0)));
    clearTimeout(win.moveTimer);
    win.moveTimer = setTimeout(() => flushMove(win), wait);
  }

  async function flushMove(win) {
    const body = win.pendingMove;
    if (!body || !windows.has(win.id)) return;
    win.pendingMove = null;
    win.moveInFlight = true;
    win.lastMoveAt = Date.now();
    try {
      const res = await request(`/api/file/${win.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      });
      if (res && Number.isFinite(res.z)) {
        win.file.z = res.z;
        if (!win.dragging) place(win);
        else win.el.style.zIndex = String(res.z);
      }
    } catch (err) {
      if (err && err.status === 404) removeWindow(win.id);
    } finally {
      win.moveInFlight = false;
      if (win.pendingMove) sendMove(win);
    }
  }

  // ---- Adding, updating and removing windows ----------------------------------

  function addWindow(file, { fresh = true } = {}) {
    const win = buildWindow(file);
    windows.set(file.id, win);
    if (fresh) win.el.classList.add('fresh');
    layer.append(win.el);
    place(win);
    setTimeout(() => win.el.classList.remove('fresh'), 1800);
    return win;
  }

  function removeWindow(id, { quiet = false } = {}) {
    const win = windows.get(id);
    if (!win) return;
    windows.delete(id);
    if (lightbox.dataset.id === id) closeLightbox();
    if (quiet) {
      win.el.remove();
      return;
    }
    win.el.classList.add('leaving');
    win.inner.addEventListener('animationend', () => win.el.remove(), { once: true });
    setTimeout(() => win.el.remove(), 600);
  }

  function applyMeta(meta, { fresh = true } = {}) {
    // Our own upload: the placeholder window becomes the real file (no second window).
    if (meta.token && pendingUploads.has(meta.token)) {
      adoptPlaceholder(pendingUploads.get(meta.token), meta);
      return;
    }
    const win = windows.get(meta.id);
    if (!win) {
      addWindow(meta, { fresh });
      return;
    }
    const moved = win.file.x !== meta.x || win.file.y !== meta.y;
    Object.assign(win.file, meta);
    renderMeta(win);
    if (!win.dragging) place(win, moved);
  }

  function adoptPlaceholder(win, meta) {
    pendingUploads.delete(meta.token);
    windows.delete(win.id);
    const localPreview = win.file.localPreview;
    win.id = meta.id;
    win.file = { ...meta, localPreview };
    win.el.classList.remove('uploading', 'failed');
    win.el.classList.add('done');
    setTimeout(() => win.el.classList.remove('done'), 1200);
    windows.set(meta.id, win);
    renderMeta(win);
    win.close.title = 'Remove for everyone';
    win.close.setAttribute('aria-label', 'Remove for everyone');
    if (!win.dragging) place(win);
  }

  function onMoved(event) {
    const win = windows.get(event.id);
    if (!win) return;
    win.file.z = event.z;
    if (event.by === clientId || win.dragging) {
      win.el.style.zIndex = String(event.z);
      topZ = Math.max(topZ, event.z);
      return;
    }
    win.file.x = event.x;
    win.file.y = event.y;
    place(win, true);
    win.el.classList.add('remote-moving');
    clearTimeout(win.remoteTimer);
    win.remoteTimer = setTimeout(() => win.el.classList.remove('remote-moving'), 450);
  }

  async function refresh() {
    let list;
    try {
      list = await request(filesUrl, { headers: { Accept: 'application/json' } });
    } catch {
      return;
    }
    if (!Array.isArray(list)) return;
    const ids = new Set(list.map((f) => f.id));
    for (const [id, win] of windows) {
      if (!ids.has(id) && !win.file.uploading) removeWindow(id);
    }
    list.forEach((meta, index) => {
      if (windows.has(meta.id)) applyMeta(meta);
      else setTimeout(() => applyMeta(meta), index * 70); // staggered entrance
    });
  }

  /** Wires a (new) EventSource. */
  function attach(source) {
    const parse = (handler) => (e) => {
      try {
        handler(JSON.parse(e.data));
      } catch {
        // ignore malformed frames
      }
    };
    source.addEventListener('file-added', parse((meta) => applyMeta(meta)));
    source.addEventListener('file-moved', parse(onMoved));
    source.addEventListener(
      'file-removed',
      parse((e) => {
        const win = windows.get(e.id);
        if (win && e.expired) toast(`“${win.file.name}” expired`, { ms: 2200 });
        removeWindow(e.id);
      }),
    );
    source.addEventListener('open', () => refresh());
  }

  // ---- Upload --------------------------------------------------------------------

  async function upload(file, at) {
    if (file.size === 0) {
      toast(`“${file.name}” is empty`, { kind: 'error' });
      return;
    }
    if (file.size > limits.maxFileBytes) {
      toast(`“${file.name}” is larger than ${formatBytes(limits.maxFileBytes)}`, { kind: 'error', ms: 3500 });
      return;
    }

    const token = randomToken();
    const pos = at || { x: 0.35 + Math.random() * 0.3, y: 0.15 + Math.random() * 0.25 };
    const placeholder = {
      id: `local-${token}`,
      token,
      name: file.name || 'file',
      type: file.type,
      size: file.size,
      x: pos.x,
      y: pos.y,
      z: ++topZ,
      uploading: true,
      localPreview: null,
    };
    const win = buildWindow(placeholder, { local: true });
    win.el.classList.add('uploading', 'fresh');
    windows.set(placeholder.id, win);
    pendingUploads.set(token, win);
    layer.append(win.el);
    place(win);
    win.close.title = 'Cancel upload';
    win.close.setAttribute('aria-label', 'Cancel upload');

    let preview = null;
    if (isImage(file)) {
      // Show the picture right away, then send a lighter copy for everyone else.
      const keepOriginal = KEEP_ORIGINAL_AS_PREVIEW.has(file.type) && file.size <= 3 * 1024 * 1024;
      preview = keepOriginal ? null : await makePreview(file);
      const localSrc = preview ? URL.createObjectURL(preview.blob) : keepOriginal ? URL.createObjectURL(file) : null;
      if (localSrc && windows.has(win.id)) {
        win.file.localPreview = localSrc;
        win.file.previewWidth = preview?.width;
        win.file.previewHeight = preview?.height;
        win.file.width = preview?.originalWidth;
        win.file.height = preview?.originalHeight;
        renderMedia(win);
        renderMeta(win);
        win.head.querySelector('.file-kind').replaceChildren(icon(ICONS.image));
        place(win);
      }
    }

    const parts = preview ? [preview.blob, file] : [file];
    const headers = {
      'Content-Type': 'application/octet-stream',
      'X-File-Name': encodeURIComponent(file.name || 'file'),
      'X-File-Type': file.type || 'application/octet-stream',
      'X-Upload-Token': token,
    };
    if (preview) {
      Object.assign(headers, {
        'X-Preview-Length': String(preview.blob.size),
        'X-Preview-Type': preview.type,
        'X-Preview-Width': String(preview.width),
        'X-Preview-Height': String(preview.height),
      });
      if (preview.originalWidth) headers['X-Image-Width'] = String(preview.originalWidth);
      if (preview.originalHeight) headers['X-Image-Height'] = String(preview.originalHeight);
    }

    const xhr = new XMLHttpRequest();
    win.xhr = xhr;
    xhr.open('POST', `${filesUrl}?x=${pos.x.toFixed(4)}&y=${pos.y.toFixed(4)}`);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.responseType = 'json';
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) win.bar.style.transform = `scaleX(${(e.loaded / e.total).toFixed(3)})`;
    });

    const failed = (message) => {
      pendingUploads.delete(token);
      if (!windows.has(win.id)) return;
      win.el.classList.remove('uploading');
      win.el.classList.add('failed');
      if (message) toast(message, { kind: 'error', ms: 3500 });
      setTimeout(() => removeWindow(win.id), 1400);
    };

    xhr.addEventListener('load', () => {
      if (xhr.status === 201 && xhr.response) {
        if (pendingUploads.has(token)) adoptPlaceholder(win, xhr.response);
        return;
      }
      const code = xhr.response && xhr.response.error;
      const messages = {
        'file-too-large': `“${file.name}” is larger than ${formatBytes(limits.maxFileBytes)}`,
        'too-many-files': `This page already has ${limits.maxFilesPerPage} files. Remove one first.`,
        'storage-full': 'The server is out of space for shared files right now.',
        'rate-limited': 'Too many requests. Try again in a moment.',
      };
      failed(messages[code] || `Could not upload “${file.name}”`);
    });
    xhr.addEventListener('error', () => failed(`Could not upload “${file.name}” (connection lost)`));
    xhr.addEventListener('abort', () => failed(null));
    xhr.send(new Blob(parts));
  }

  function uploadMany(list, at) {
    const files = [...list].slice(0, MAX_FILES_PER_DROP);
    if (list.length > MAX_FILES_PER_DROP) toast(`Only the first ${MAX_FILES_PER_DROP} files were added`, { ms: 3000 });
    files.forEach((file, index) => {
      const offset = at ? { x: Math.min(1, at.x + index * 0.03), y: Math.min(1, at.y + index * 0.05) } : null;
      upload(file, offset);
    });
  }

  // ---- Drag and drop onto the page -------------------------------------------------

  const hasFiles = (e) => Boolean(e.dataTransfer) && [...e.dataTransfer.types].includes('Files');
  let dragDepth = 0;

  function moveLanding(e) {
    const rect = layer.getBoundingClientRect();
    const w = cardWidth();
    const left = Math.min(Math.max(rect.left, e.clientX - w / 2), rect.right - w);
    const top = Math.min(Math.max(rect.top, e.clientY - 24), rect.bottom - 120);
    landing.style.width = `${w}px`;
    landing.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
  }

  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth += 1;
    overlay.hidden = false;
    requestAnimationFrame(() => {
      if (dragDepth > 0) overlay.classList.add('show');
    });
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    moveLanding(e);
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) hideOverlay();
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    hideOverlay();
    if (e.dataTransfer.files.length) uploadMany(e.dataTransfer.files, fractionsAt(e.clientX, e.clientY));
  });

  function hideOverlay() {
    overlay.classList.remove('show');
    setTimeout(() => {
      if (!overlay.classList.contains('show')) overlay.hidden = true;
    }, 200);
  }

  // Paste files (e.g. a screenshot) straight onto the page.
  document.addEventListener('paste', (e) => {
    const files = e.clipboardData ? [...e.clipboardData.files] : [];
    if (files.length === 0) return;
    e.preventDefault();
    uploadMany(files);
  });

  // Paperclip button.
  const input = document.getElementById('file-input');
  document.getElementById('attach-btn').addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    if (input.files.length) uploadMany(input.files);
    input.value = '';
  });

  // ---- Lightbox (larger preview, original via download) -----------------------------

  let lightboxOpen = false;

  function openLightbox(win) {
    const img = lightbox.querySelector('img');
    img.src = win.file.localPreview || `/api/file/${win.id}/preview`;
    img.alt = win.file.name;
    lightbox.querySelector('.lightbox-name').textContent = win.file.name;
    const dims = win.file.width && win.file.height ? `${win.file.width} × ${win.file.height} · ` : '';
    lightbox.querySelector('.lightbox-info').textContent = `${dims}${formatBytes(win.file.size)} · preview shown in lower quality`;
    const link = lightbox.querySelector('.lightbox-download');
    if (win.file.id && !win.file.uploading) {
      link.href = `/api/file/${win.file.id}`;
      link.setAttribute('download', win.file.name);
      link.hidden = false;
    } else {
      link.hidden = true;
    }
    lightbox.dataset.id = win.id;
    const rect = (win.thumb || win.el).getBoundingClientRect();
    lightbox.style.setProperty('--from-x', `${rect.left + rect.width / 2 - window.innerWidth / 2}px`);
    lightbox.style.setProperty('--from-y', `${rect.top + rect.height / 2 - window.innerHeight / 2}px`);
    lightbox.hidden = false;
    lightboxOpen = true;
    requestAnimationFrame(() => {
      if (lightboxOpen) lightbox.classList.add('show');
    });
    lightbox.querySelector('.lightbox-close').focus();
  }

  function closeLightbox() {
    if (lightbox.hidden) return;
    lightboxOpen = false;
    lightbox.classList.remove('show');
    delete lightbox.dataset.id;
    setTimeout(() => {
      if (!lightbox.classList.contains('show')) lightbox.hidden = true;
    }, 250);
  }

  lightbox.addEventListener('click', (e) => {
    if (!e.target.closest('.lightbox-download')) closeLightbox();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeLightbox();
  });

  // Countdown labels.
  setInterval(() => {
    for (const win of windows.values()) if (win.file.expiresAt) win.metaExpiry.textContent = untilLabel(win.file.expiresAt);
  }, 30_000);

  return {
    attach,
    refresh,
    setLimits(cfg) {
      if (Number.isFinite(cfg.maxFileBytes)) limits.maxFileBytes = cfg.maxFileBytes;
      if (Number.isFinite(cfg.maxFilesPerPage)) limits.maxFilesPerPage = cfg.maxFilesPerPage;
    },
    get count() {
      return windows.size;
    },
  };
}
