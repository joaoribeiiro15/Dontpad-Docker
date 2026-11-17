// Normalização e validação de caminhos de página (regras da secção 3).
//
// Um caminho canónico começa por "/", não tem barra final nem barras
// duplicadas, e distingue maiúsculas de minúsculas: "/notas/Reuniao".

export const MAX_PATH_LENGTH = 255;
export const RESERVED = new Set(['api', 'assets', 'healthz', 'robots.txt']);

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Converte um pathname (ainda codificado, tal como chega no URL) num caminho
 * canónico. Devolve { ok: true, path, segments } ou { ok: false, error }, onde
 * error é "invalid-path" ou "nesting-limit-reached".
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

/** Converte um caminho canónico no pathname codificado usado nos URLs. */
export function encodePath(path) {
  return path
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
}

/** Regra de versão: nunca repete nem recua (secção 6). */
export function nextLastModified(previous, now = Date.now()) {
  return Math.max(now, previous + 1);
}
