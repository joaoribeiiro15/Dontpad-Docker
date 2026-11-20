// The public address people use to reach this server (shown on the home page
// and used for copied links). Chosen once at first-run setup, or by PUBLIC_ADDRESS.

const LOCAL_HOST = /^(localhost|\[[0-9a-f:.]+\]|\d{1,3}(\.\d{1,3}){3})$|\.(local|lan|home|internal|localhost)$/i;

/**
 * Normalizes what someone typed ("notes.example.com", "http://192.168.1.20:3000/",
 * "https://pad.example.org") into an origin. Without a scheme, local names and IP
 * addresses get http://, anything else https://.
 * Returns { ok: true, origin, host } or { ok: false, error: 'invalid-address' }.
 */
export function normalizeAddress(raw) {
  const fail = { ok: false, error: 'invalid-address' };
  if (typeof raw !== 'string') return fail;
  let value = raw.trim();
  if (value === '' || value.length > 300 || /[\s\\]/.test(value)) return fail;

  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    const hostPart = value.split(/[/?#]/)[0].replace(/:\d+$/, '');
    value = `${LOCAL_HOST.test(hostPart) ? 'http' : 'https'}://${value}`;
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    return fail;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return fail;
  if (url.username || url.password || url.search || url.hash) return fail;
  if (url.pathname !== '/' && url.pathname !== '') return fail;
  if (!url.hostname || url.hostname.length > 253) return fail;
  // A host name needs at least one letter or digit in each label.
  if (!url.hostname.startsWith('[') && !url.hostname.split('.').every((label) => /^[a-z0-9-]+$/i.test(label) && !label.startsWith('-') && !label.endsWith('-'))) {
    return fail;
  }
  return { ok: true, origin: url.origin, host: url.host };
}

const SETTING = 'public_address';

/** Reads and writes the address; the environment variable always wins. */
export function addressStore(config, db) {
  return {
    /** { origin, host, source: 'env' | 'setup' } or null when setup is still needed. */
    get() {
      if (config.publicAddress) return { ...normalizeAddress(config.publicAddress), source: 'env' };
      const stored = db.getSetting(SETTING);
      if (!stored) return null;
      const parsed = normalizeAddress(stored);
      return parsed.ok ? { origin: parsed.origin, host: parsed.host, source: 'setup' } : null;
    },
    /** First-run setup: only succeeds once. */
    setOnce(raw) {
      if (config.publicAddress) return { ok: false, error: 'configured-by-env' };
      const parsed = normalizeAddress(raw);
      if (!parsed.ok) return parsed;
      if (!db.insertSetting(SETTING, parsed.origin)) return { ok: false, error: 'already-configured' };
      return { ok: true, origin: parsed.origin, host: parsed.host };
    },
  };
}

export const ADDRESS_SETTING = SETTING;
