import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply, diff, merge3 } from '../public/assets/merge.js';

test('diff + apply round-trip', () => {
  for (const [a, b] of [
    ['', 'hello'],
    ['hello', ''],
    ['hello world', 'hello brave new world'],
    ['abcdef', 'abXYef'],
    ['aaaa', 'aaa'],
    ['😀 emoji', '😀 emojis 🎉'],
  ]) {
    assert.equal(apply(a, diff(a, b)), b);
  }
  assert.equal(diff('same', 'same'), null);
});

test('edits in different places are both kept', () => {
  const base = 'alpha\nbeta\ngamma';
  const local = 'ALPHA\nbeta\ngamma';
  const remote = 'alpha\nbeta\nGAMMA!';
  assert.deepEqual(merge3(base, local, remote), { ok: true, text: 'ALPHA\nbeta\nGAMMA!' });
  assert.deepEqual(merge3(base, remote, local), { ok: true, text: 'ALPHA\nbeta\nGAMMA!' });
});

test('one side unchanged takes the other side', () => {
  assert.deepEqual(merge3('a', 'a', 'b'), { ok: true, text: 'b' });
  assert.deepEqual(merge3('a', 'b', 'a'), { ok: true, text: 'b' });
  assert.deepEqual(merge3('a', 'b', 'b'), { ok: true, text: 'b' });
});

test('two insertions at the same point: remote first', () => {
  assert.deepEqual(merge3('ab', 'aLb', 'aRb'), { ok: true, text: 'aRLb' });
  assert.deepEqual(merge3('', 'local', 'remote'), { ok: true, text: 'remotelocal' });
});

test('adjacent edits merge', () => {
  // local replaces "world", remote appends right after it
  assert.deepEqual(merge3('hello world', 'hello there', 'hello world!'), { ok: true, text: 'hello there!' });
  // remote inserts where local's replaced range starts
  assert.deepEqual(merge3('hello world', 'hello there', 'hello big world'), { ok: true, text: 'hello big there' });
});

test('overlapping edits are a conflict', () => {
  assert.deepEqual(merge3('hello world', 'hello there', 'hello folks'), { ok: false });
  assert.deepEqual(merge3('0123456789', '01AB6789', '0123CD89'), { ok: false });
  // insertion strictly inside the other side's deleted range
  assert.deepEqual(merge3('abcdef', 'af', 'abcXdef'), { ok: false });
});

test('random disjoint edits always merge to both changes', () => {
  let seed = 7;
  const rnd = (n) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const chars = 'abcdefgh \n';
  for (let round = 0; round < 500; round++) {
    let base = '';
    for (let k = 10 + rnd(30); k > 0; k--) base += chars[rnd(chars.length)];
    const cut = 3 + rnd(base.length - 6);
    // local edits strictly left of the cut, remote strictly right of it
    const lp = rnd(cut - 1);
    const ld = rnd(cut - 1 - lp);
    const rp = cut + 1 + rnd(base.length - cut - 1);
    const rd = rnd(base.length - rp + 1);
    const local = base.slice(0, lp) + 'L'.repeat(rnd(3)) + base.slice(lp + ld);
    const remote = base.slice(0, rp) + 'R'.repeat(rnd(3)) + base.slice(rp + rd);
    const expected = base.slice(0, lp) + local.slice(lp, local.length - (base.length - lp - ld)) + base.slice(lp + ld, rp) + remote.slice(rp, remote.length - (base.length - rp - rd)) + base.slice(rp + rd);
    const merged = merge3(base, local, remote);
    assert.ok(merged.ok, `round ${round}`);
    assert.equal(merged.text, expected, `round ${round}: ${JSON.stringify({ base, local, remote })}`);
  }
});
