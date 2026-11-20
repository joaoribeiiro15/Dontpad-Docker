import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodePath, nextLastModified, parsePath } from '../src/paths.js';

const ok = (raw, opts) => {
  const r = parsePath(raw, opts);
  assert.ok(r.ok, `${raw} should be valid: ${r.error}`);
  return r.path;
};
const err = (raw, opts) => {
  const r = parsePath(raw, opts);
  assert.equal(r.ok, false, `${raw} should be invalid`);
  return r.error;
};

test('drops the trailing slash and collapses repeated slashes', () => {
  assert.equal(ok('/notes'), '/notes');
  assert.equal(ok('/notes/'), '/notes');
  assert.equal(ok('//notes///meeting//'), '/notes/meeting');
  assert.equal(ok('notes'), '/notes');
});

test('decodes the URL and is case-sensitive', () => {
  assert.equal(ok('/ol%C3%A1%20world'), '/olá world');
  assert.equal(ok('/Notes'), '/Notes');
  assert.notEqual(ok('/Notes'), ok('/notes'));
  assert.equal(ok('/a%2Fb'), '/a/b');
  assert.equal(ok('/100%25'), '/100%');
});

test('rejects invalid paths', () => {
  for (const raw of ['/', '', '/%E0%A4%A', '/a/../b', '/./a', '/a%00b', '/a%0Ab', '/' + 'x'.repeat(255)]) {
    assert.equal(err(raw), 'invalid-path', raw);
  }
  assert.equal(err(undefined), 'invalid-path');
});

test('accepts exactly 255 characters', () => {
  assert.equal(ok('/' + 'x'.repeat(254)).length, 255);
});

test('reserves api, assets, healthz and robots.txt as the first segment', () => {
  for (const raw of ['/api', '/api/x', '/assets/a.css', '/healthz', '/API', '/robots.txt']) assert.equal(err(raw), 'invalid-path', raw);
  assert.equal(ok('/notes/api'), '/notes/api');
  assert.equal(ok('/apis'), '/apis');
});

test('nesting limit', () => {
  const ten = '/' + Array.from({ length: 10 }, (_, i) => `n${i}`).join('/');
  assert.equal(ok(ten), ten);
  assert.equal(err(ten + '/extra'), 'nesting-limit-reached');
  assert.equal(err('/a/b/c', { maxDepth: 2 }), 'nesting-limit-reached');
});

test('encodePath is the inverse of parsePath', () => {
  for (const p of ['/notes', '/olá world/sub', '/100%/a?b#c']) {
    assert.equal(parsePath(encodePath(p)).path, p);
  }
});

test('lastModified rule: never repeats, never goes back', () => {
  assert.equal(nextLastModified(0, 1000), 1000);
  assert.equal(nextLastModified(999, 1000), 1000);
  assert.equal(nextLastModified(1000, 1000), 1001);
  assert.equal(nextLastModified(5000, 1000), 5001); // clock behind
});
