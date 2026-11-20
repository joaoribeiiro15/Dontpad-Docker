// Password-protected pages.
//
// The password is stored as an scrypt hash. Whoever types it gets an access
// key for that page in an HttpOnly cookie: an HMAC of the page path and the
// lock's nonce, signed with a server secret kept in the database. Setting a
// new password changes the nonce, so every key issued before stops working
// at once, and everyone else on the page has to type the new one.

import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LENGTH = 32;
const COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60;

export const MIN_PASSWORD = 4;
export const MAX_PASSWORD = 256;

const SECRET_SETTING = 'access_key_secret';

export function validPassword(value) {
  return typeof value === 'string' && [...value].length >= MIN_PASSWORD && value.length <= MAX_PASSWORD;
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password.normalize('NFC'), salt, KEY_LENGTH, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const [kind, n, r, p, salt, hash] = String(stored).split('$');
  if (kind !== 'scrypt' || !salt || !hash || typeof password !== 'string') return false;
  try {
    const expected = Buffer.from(hash, 'base64');
    const actual = await scrypt(password.normalize('NFC'), Buffer.from(salt, 'base64'), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: SCRYPT.maxmem,
    });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function parseCookies(header) {
  const out = new Map();
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return out;
}

export function createLocks(db) {
  let secret = db.getSetting(SECRET_SETTING);
  if (!secret) {
    db.insertSetting(SECRET_SETTING, crypto.randomBytes(32).toString('base64'));
    secret = db.getSetting(SECRET_SETTING);
  }
  const key = Buffer.from(secret, 'base64');

  const cookieName = (path) => `opk_${crypto.createHash('sha256').update(path).digest('hex').slice(0, 20)}`;
  const accessKey = (path, nonce) => crypto.createHmac('sha256', key).update(`${path}\n${nonce}`).digest('base64url');

  function cookie(path, value, { secure, maxAge }) {
    return `${cookieName(path)}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
  }

  return {
    isProtected: (path) => db.getLock(path) !== null,

    /** True when the page has no password, or the request carries a valid key for it. */
    hasAccess(request, path) {
      const lock = db.getLock(path);
      if (!lock) return true;
      const sent = parseCookies(request.headers.cookie).get(cookieName(path));
      if (!sent) return false;
      const a = Buffer.from(sent);
      const b = Buffer.from(accessKey(path, lock.nonce));
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    },

    /** Sets or changes the password. Returns the Set-Cookie value for the person who set it. */
    async protect(path, password, { secure }) {
      const hash = await hashPassword(password);
      const nonce = crypto.randomBytes(16).toString('base64url');
      db.putLock(path, hash, nonce);
      return cookie(path, accessKey(path, nonce), { secure, maxAge: COOKIE_MAX_AGE_S });
    },

    /** Checks a password. Returns the Set-Cookie value, or null when it is wrong. */
    async unlock(path, password, { secure }) {
      const lock = db.getLock(path);
      if (!lock) return '';
      if (!(await verifyPassword(password, lock.hash))) return null;
      return cookie(path, accessKey(path, lock.nonce), { secure, maxAge: COOKIE_MAX_AGE_S });
    },

    /** Removes the password; returns a Set-Cookie that clears the key. */
    remove(path, { secure }) {
      db.deleteLock(path);
      return cookie(path, '', { secure, maxAge: 0 });
    },
  };
}
