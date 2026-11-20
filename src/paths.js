// Page path normalisation and validation.
//
// A canonical path starts with "/", has no trailing slash and no repeated
// slashes, and is case-sensitive: "/notes/Meeting".

export const MAX_PATH_LENGTH = 255;
export const RESERVED = new Set(['api', 'assets', 'healthz', 'robots.txt']);

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Turns a pathname (still percent-encoded, as it arrives in the URL) into a
 * canonical path. Returns { ok: true, path, segments } or { ok: false, error },
 * where error is "invalid-path" or "nesting-limit-reached".
 */
export function parsePath(rawPathname, { maxDepth = 10 } = {}) {
  if (typeof rawPathname !== 'string') return { ok: false, error: 'invalid-path' };

  let decoded;
  try {
    decoded = decodeURIComponent(rawPathname);
  } catch {
    return { ok: false, error: 'invalid-path' };
  }

  if (CONTROL.test(decoded)) return { ok: false, error: 'invalid-path' };

  const segments = decoded.split('/').filter((s) => s !== '');
  if (segments.length === 0) return { ok: false, error: 'invalid-path' };
  if (segments.some((s) => s === '.' || s === '..')) return { ok: false, error: 'invalid-path' };
  if (RESERVED.has(segments[0].toLowerCase())) return { ok: false, error: 'invalid-path' };

  const path = '/' + segments.join('/');
  if (path.length > MAX_PATH_LENGTH) return { ok: false, error: 'invalid-path' };
  if (segments.length > maxDepth) return { ok: false, error: 'nesting-limit-reached' };

  return { ok: true, path, segments };
}

/** Turns a canonical path into the percent-encoded pathname used in URLs. */
export function encodePath(path) {
  return path
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
}

/** Version rule: never repeats and never goes back. */
export function nextLastModified(previous, now = Date.now()) {
  return Math.max(now, previous + 1);
}
