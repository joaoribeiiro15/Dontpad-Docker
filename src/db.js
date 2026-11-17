// Ligação SQLite, esquema e prepared statements (secção 6).

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
`;

// Primeiro segmento abaixo de :p, mesmo quando só existe um descendente mais
// profundo. O intervalo ] :p/ , :p0 [ usa o índice da chave primária, porque
// "0" é o carácter seguinte a "/" em ASCII.
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
  };

  /** Uma página inexistente comporta-se como body "" e lastModified 0. */
  function read(p) {
    return stmt.get.get(p) ?? { body: '', lastModified: 0 };
  }

  // Comparação e escrita na mesma transação: dois pedidos simultâneos nunca passam ambos.
  const saveTx = db.transaction((p, body, clientLastModified, force) => {
    const current = read(p);
    if (!force && clientLastModified !== current.lastModified) {
      return { ok: false, error: 'update-timestamp-mismatch' };
    }
    if (body === '') {
      // Gravar texto vazio apaga o registo; a página volta a ter lastModified 0.
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
    healthy() {
      try {
        return stmt.ping.get() === 1;
      } catch {
        return false;
      }
    },
    /** Cópia consistente com o serviço a correr. */
    backup: (dest) => db.backup(dest),
    close() {
      if (db.open) db.close();
    },
    raw: db,
  };
}
