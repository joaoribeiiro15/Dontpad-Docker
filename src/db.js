// SQLite connection, schema and prepared statements.

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { nextLastModified } from './paths.js';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS pages (
    path          TEXT PRIMARY KEY,
    body          TEXT NOT NULL,
    last_modified INTEGER NOT NULL
  ) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) WITHOUT ROWID;
`;

// First segment below :p, even when only a deeper descendant exists. The range
// ] :p/ , :p0 [ uses the primary key index, because "0" is the character right
// after "/" in ASCII.
const MENU_SQL = `
  SELECT DISTINCT
    CASE WHEN instr(substr(path, length(:p) + 2), '/') = 0
         THEN substr(path, length(:p) + 2)
         ELSE substr(path, length(:p) + 2, instr(substr(path, length(:p) + 2), '/') - 1)
    END AS name
  FROM pages
  WHERE path > :p || '/' AND path < :p || '0'
`;

const TREE_SQL = `
  SELECT path, body FROM pages
  WHERE path = :p OR (path > :p || '/' AND path < :p || '0')
  ORDER BY path
`;

export function openDatabase(file, { now = () => Date.now() } = {}) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });

  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);

  const stmt = {
    get: db.prepare('SELECT body, last_modified AS lastModified FROM pages WHERE path = ?'),
    upsert: db.prepare(`
      INSERT INTO pages (path, body, last_modified) VALUES (?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET body = excluded.body, last_modified = excluded.last_modified
    `),
    remove: db.prepare('DELETE FROM pages WHERE path = ?'),
    menu: db.prepare(MENU_SQL).pluck(),
    tree: db.prepare(TREE_SQL),
    ping: db.prepare('SELECT 1').pluck(),
    getSetting: db.prepare('SELECT value FROM settings WHERE key = ?').pluck(),
    insertSetting: db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING'),
    putSetting: db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    deleteSetting: db.prepare('DELETE FROM settings WHERE key = ?'),
  };

  /** A page that does not exist behaves as body "" and lastModified 0. */
  function read(p) {
    return stmt.get.get(p) ?? { body: '', lastModified: 0 };
  }

  // Compare and write in the same transaction: two concurrent requests never both succeed.
  const saveTx = db.transaction((p, body, clientLastModified, force) => {
    const current = read(p);
    if (!force && clientLastModified !== current.lastModified) {
      return { ok: false, error: 'update-timestamp-mismatch' };
    }
    if (body === '') {
      // Saving an empty text deletes the row; the page is back to lastModified 0.
      stmt.remove.run(p);
      return { ok: true, lastModified: 0 };
    }
    const lastModified = nextLastModified(current.lastModified, now());
    stmt.upsert.run(p, body, lastModified);
    return { ok: true, lastModified };
  });

  return {
    read,
    save: (p, body, clientLastModified, force) => saveTx(p, body, clientLastModified, force),
    menu: (p) => stmt.menu.all({ p }),
    tree: (p) => stmt.tree.all({ p }),
    getSetting: (key) => stmt.getSetting.get(key) ?? null,
    /** Stores the value only if the key has none yet; true when it was stored. */
    insertSetting: (key, value) => stmt.insertSetting.run(key, value).changes === 1,
    putSetting: (key, value) => void stmt.putSetting.run(key, value),
    deleteSetting: (key) => stmt.deleteSetting.run(key).changes === 1,
    healthy() {
      try {
        return stmt.ping.get() === 1;
      } catch {
        return false;
      }
    },
    /** Consistent copy while the service is running. */
    backup: (dest) => db.backup(dest),
    close() {
      if (db.open) db.close();
    },
    raw: db,
  };
}
