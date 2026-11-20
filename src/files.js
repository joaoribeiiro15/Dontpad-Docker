// Temporary shared files, kept in memory only.
//
// Files dropped on a page float over it for everyone. They are never written
// to disk: a restart (or crash) of the server forgets all of them, and each
// file also expires FILE_TTL_MS after it was added.

import crypto from 'node:crypto';

// eslint-disable-next-line no-control-regex
const UNSAFE_NAME = /[\u0000-\u001f\u007f\\/:*?"<>|]/g;
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,127}$/i;

/**
 * Image types whose original may double as its own preview when the uploader did
 * not send one (e.g. an upload with curl). SVG is left out on purpose: it can
 * carry scripts, so it only ever gets a rasterised preview made by the browser.
 */
export const PREVIEWABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp']);
export const PREVIEW_TYPES = new Set(['image/webp', 'image/jpeg', 'image/png']);
export const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
const MAX_ORIGINAL_AS_PREVIEW = 3 * 1024 * 1024;

const dimension = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n <= 100_000 ? n : null;
};

export function cleanName(raw) {
  let name = '';
  try {
    name = decodeURIComponent(String(raw ?? ''));
  } catch {
    name = String(raw ?? '');
  }
  name = name.replace(UNSAFE_NAME, '_').replace(/\s+/g, ' ').trim();
  if (name === '' || name === '.' || name === '..') name = 'file';
  if (name.length > 200) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : '';
    name = name.slice(0, 200 - ext.length) + ext;
  }
  return name;
}

export function cleanType(raw) {
  const type = String(raw ?? '').trim().toLowerCase();
  return MIME.test(type) ? type : 'application/octet-stream';
}

const clamp01 = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
};

export class FileStore {
  constructor({ maxFileBytes, maxFilesPerPage, maxTotalBytes, ttlMs, now = () => Date.now() }) {
    this.maxFileBytes = maxFileBytes;
    this.maxFilesPerPage = maxFilesPerPage;
    this.maxTotalBytes = maxTotalBytes;
    this.ttlMs = ttlMs;
    this.now = now;
    this.pages = new Map(); // path -> { files: Map<id, file>, z: number }
    this.byId = new Map(); // id -> file
    this.totalBytes = 0;
  }

  static meta(file) {
    const { id, token, name, type, size, createdAt, expiresAt, x, y, z, width, height } = file;
    return {
      id,
      token,
      name,
      type,
      size,
      createdAt,
      expiresAt,
      x,
      y,
      z,
      width,
      height,
      preview: FileStore.previewOf(file) !== null,
      previewWidth: file.preview?.width ?? width,
      previewHeight: file.preview?.height ?? height,
    };
  }

  /** The lower-quality image shown on the page: the uploaded preview, or a small enough original. */
  static previewOf(file) {
    if (file.preview) return file.preview;
    if (PREVIEWABLE.has(file.type) && file.size <= MAX_ORIGINAL_AS_PREVIEW) return { data: file.data, type: file.type };
    return null;
  }

  /**
   * Returns { ok: true, file } or { ok: false, error }. `preview` is an optional
   * { data, type, width, height } made by the browser for images.
   */
  add(path, { name, type, x, y, width, height, token }, data, preview = null) {
    if (data.length === 0) return { ok: false, error: 'empty-file' };
    if (data.length > this.maxFileBytes) return { ok: false, error: 'file-too-large' };
    if (preview && (preview.data.length === 0 || preview.data.length > MAX_PREVIEW_BYTES || !PREVIEW_TYPES.has(preview.type))) {
      return { ok: false, error: 'invalid-preview' };
    }
    const bytes = data.length + (preview?.data.length ?? 0);
    const page = this.pages.get(path) ?? { files: new Map(), z: 0 };
    if (page.files.size >= this.maxFilesPerPage) return { ok: false, error: 'too-many-files' };
    if (this.totalBytes + bytes > this.maxTotalBytes) return { ok: false, error: 'storage-full' };

    const createdAt = this.now();
    page.z += 1;
    const file = {
      id: crypto.randomUUID(),
      // Random tag chosen by the uploader, so its own placeholder window can adopt the file.
      token: typeof token === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(token) ? token : null,
      path,
      name: cleanName(name),
      type: cleanType(type),
      size: data.length,
      bytes,
      data,
      width: dimension(width),
      height: dimension(height),
      preview: preview
        ? { data: preview.data, type: preview.type, width: dimension(preview.width), height: dimension(preview.height) }
        : null,
      createdAt,
      expiresAt: createdAt + this.ttlMs,
      x: clamp01(x, 0.5),
      y: clamp01(y, 0.3),
      z: page.z,
    };
    page.files.set(file.id, file);
    this.pages.set(path, page);
    this.byId.set(file.id, file);
    this.totalBytes += bytes;
    return { ok: true, file };
  }

  list(path) {
    const page = this.pages.get(path);
    if (!page) return [];
    return [...page.files.values()].sort((a, b) => a.z - b.z).map(FileStore.meta);
  }

  get(id) {
    const file = this.byId.get(id);
    if (!file) return null;
    if (file.expiresAt <= this.now()) {
      this.remove(id);
      return null;
    }
    return file;
  }

  /** Moves a file (normalised 0..1 coordinates); `front` also raises it above the others. */
  move(id, { x, y, front = false }) {
    const file = this.get(id);
    if (!file) return null;
    file.x = clamp01(x, file.x);
    file.y = clamp01(y, file.y);
    if (front) {
      const page = this.pages.get(file.path);
      if (file.z !== page.z) {
        page.z += 1;
        file.z = page.z;
      }
    }
    return file;
  }

  remove(id) {
    const file = this.byId.get(id);
    if (!file) return null;
    this.byId.delete(id);
    this.totalBytes -= file.bytes;
    const page = this.pages.get(file.path);
    page.files.delete(id);
    if (page.files.size === 0) this.pages.delete(file.path);
    return file;
  }

  /** Removes expired files and returns them. */
  sweep() {
    const now = this.now();
    const expired = [];
    for (const file of this.byId.values()) {
      if (file.expiresAt <= now) expired.push(file);
    }
    for (const file of expired) this.remove(file.id);
    return expired;
  }

  stats() {
    return { files: this.byId.size, bytes: this.totalBytes };
  }
}
