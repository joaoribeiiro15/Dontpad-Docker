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

test('missing page: empty body and lastModified 0', () => {
  const db = openDatabase(':memory:');
  assert.deepEqual(db.read('/nothing'), { body: '', lastModified: 0 });
  db.close();
});

test('saves with the right lastModified, refuses a stale one, accepts force', () => {
  const now = fixedClock();
  const db = openDatabase(':memory:', { now });

  const first = db.save('/a', 'one', 0, false);
  assert.deepEqual(first, { ok: true, lastModified: 1_000_000 });

  // Same instant: the version still moves forward.
  const second = db.save('/a', 'two', first.lastModified, false);
  assert.deepEqual(second, { ok: true, lastModified: 1_000_001 });

  assert.deepEqual(db.save('/a', 'stale', first.lastModified, false), { ok: false, error: 'update-timestamp-mismatch' });
  assert.deepEqual(db.save('/a', 'stale', 0, false), { ok: false, error: 'update-timestamp-mismatch' });
  assert.equal(db.read('/a').body, 'two');

  now.set(500); // clock going back
  const forced = db.save('/a', 'forced', 123, true);
  assert.deepEqual(forced, { ok: true, lastModified: 1_000_002 });
  assert.deepEqual(db.read('/a'), { body: 'forced', lastModified: 1_000_002 });
  db.close();
});

test('saving empty text deletes the row', () => {
  const db = openDatabase(':memory:');
  const r = db.save('/a', 'x', 0, false);
  assert.deepEqual(db.save('/a', '', r.lastModified, false), { ok: true, lastModified: 0 });
  assert.deepEqual(db.read('/a'), { body: '', lastModified: 0 });
  assert.equal(db.raw.prepare('SELECT count(*) FROM pages').pluck().get(), 0);
  db.close();
});

test('menu: first level below the path, including deep descendants', () => {
  const db = openDatabase(':memory:');
  for (const p of ['/notes', '/notes/meeting', '/notes/shopping', '/notes/shopping/may', '/notes/deep/a/b', '/notes0', '/notes-x/y', '/other/z']) {
    db.save(p, 'x', 0, false);
  }
  assert.deepEqual(db.menu('/notes').sort(), ['deep', 'meeting', 'shopping']);
  assert.deepEqual(db.menu('/notes/shopping'), ['may']);
  assert.deepEqual(db.menu('/notes/meeting'), []);
  assert.deepEqual(db.menu('/empty'), []);
  db.close();
});

test('menu query uses the primary key index', () => {
  const db = openDatabase(':memory:');
  const plan = db.raw
    .prepare("EXPLAIN QUERY PLAN SELECT path FROM pages WHERE path > :p || '/' AND path < :p || '0'")
    .all({ p: '/notes' })
    .map((r) => r.detail)
    .join(' ');
  assert.match(plan, /SEARCH pages USING PRIMARY KEY/);
  db.close();
});

test('tree: the page and all its descendants', () => {
  const db = openDatabase(':memory:');
  for (const p of ['/a', '/a/b', '/a/b/c', '/ab', '/a0']) db.save(p, p, 0, false);
  assert.deepEqual(
    db.tree('/a').map((r) => r.path),
    ['/a', '/a/b', '/a/b/c'],
  );
  db.close();
});
