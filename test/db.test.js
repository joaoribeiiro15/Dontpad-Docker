import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';

function fixedClock(start = 1_000_000) {
  let t = start;
  const now = () => t;
  now.set = (v) => {
    t = v;
  };
  return now;
}

test('página inexistente: body vazio e lastModified 0', () => {
  const db = openDatabase(':memory:');
  assert.deepEqual(db.read('/nada'), { body: '', lastModified: 0 });
  db.close();
});

test('gravar com o lastModified certo, recusar com outro, aceitar com force', () => {
  const now = fixedClock();
  const db = openDatabase(':memory:', { now });

  const first = db.save('/a', 'um', 0, false);
  assert.deepEqual(first, { ok: true, lastModified: 1_000_000 });

  // Mesmo instante: a versão avança na mesma.
  const second = db.save('/a', 'dois', first.lastModified, false);
  assert.deepEqual(second, { ok: true, lastModified: 1_000_001 });

  assert.deepEqual(db.save('/a', 'antigo', first.lastModified, false), { ok: false, error: 'update-timestamp-mismatch' });
  assert.deepEqual(db.save('/a', 'antigo', 0, false), { ok: false, error: 'update-timestamp-mismatch' });
  assert.equal(db.read('/a').body, 'dois');

  now.set(500); // relógio a recuar
  const forced = db.save('/a', 'forçado', 123, true);
  assert.deepEqual(forced, { ok: true, lastModified: 1_000_002 });
  assert.deepEqual(db.read('/a'), { body: 'forçado', lastModified: 1_000_002 });
  db.close();
});

test('gravar texto vazio apaga o registo', () => {
  const db = openDatabase(':memory:');
  const r = db.save('/a', 'x', 0, false);
  assert.deepEqual(db.save('/a', '', r.lastModified, false), { ok: true, lastModified: 0 });
  assert.deepEqual(db.read('/a'), { body: '', lastModified: 0 });
  assert.equal(db.raw.prepare('SELECT count(*) FROM pages').pluck().get(), 0);
  db.close();
});

test('menu: primeiro nível abaixo do caminho, incluindo descendentes profundos', () => {
  const db = openDatabase(':memory:');
  for (const p of ['/notas', '/notas/reuniao', '/notas/compras', '/notas/compras/maio', '/notas/fundo/a/b', '/notas0', '/notas-x/y', '/outra/z']) {
    db.save(p, 'x', 0, false);
  }
  assert.deepEqual(db.menu('/notas').sort(), ['compras', 'fundo', 'reuniao']);
  assert.deepEqual(db.menu('/notas/compras'), ['maio']);
  assert.deepEqual(db.menu('/notas/reuniao'), []);
  assert.deepEqual(db.menu('/vazio'), []);
  db.close();
});

test('menu usa o índice da chave primária', () => {
  const db = openDatabase(':memory:');
  const plan = db.raw
    .prepare("EXPLAIN QUERY PLAN SELECT path FROM pages WHERE path > :p || '/' AND path < :p || '0'")
    .all({ p: '/notas' })
    .map((r) => r.detail)
    .join(' ');
  assert.match(plan, /SEARCH pages USING PRIMARY KEY/);
  db.close();
});

test('tree: a página e todos os descendentes', () => {
  const db = openDatabase(':memory:');
  for (const p of ['/a', '/a/b', '/a/b/c', '/ab', '/a0']) db.save(p, p, 0, false);
  assert.deepEqual(
    db.tree('/a').map((r) => r.path),
    ['/a', '/a/b', '/a/b/c'],
  );
  db.close();
});
