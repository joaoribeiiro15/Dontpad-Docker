import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodePath, nextLastModified, parsePath } from '../src/paths.js';

const ok = (raw, opts) => {
  const r = parsePath(raw, opts);
  assert.ok(r.ok, `${raw} devia ser válido: ${r.error}`);
  return r.path;
};
const err = (raw, opts) => {
  const r = parsePath(raw, opts);
  assert.equal(r.ok, false, `${raw} devia ser inválido`);
  return r.error;
};

test('normaliza barra final e barras duplicadas', () => {
  assert.equal(ok('/notas'), '/notas');
  assert.equal(ok('/notas/'), '/notas');
  assert.equal(ok('//notas///reuniao//'), '/notas/reuniao');
  assert.equal(ok('notas'), '/notas');
});

test('descodifica o URL e distingue maiúsculas', () => {
  assert.equal(ok('/ol%C3%A1%20mundo'), '/olá mundo');
  assert.equal(ok('/Notas'), '/Notas');
  assert.notEqual(ok('/Notas'), ok('/notas'));
  assert.equal(ok('/a%2Fb'), '/a/b');
  assert.equal(ok('/100%25'), '/100%');
});

test('rejeita caminhos inválidos', () => {
  for (const raw of ['/', '', '/%E0%A4%A', '/a/../b', '/./a', '/a%00b', '/a%0Ab', '/' + 'x'.repeat(255)]) {
    assert.equal(err(raw), 'invalid-path', raw);
  }
  assert.equal(err(undefined), 'invalid-path');
});

test('aceita exatamente 255 caracteres', () => {
  assert.equal(ok('/' + 'x'.repeat(254)).length, 255);
});

test('reserva api, assets, healthz e robots.txt como primeiro segmento', () => {
  for (const raw of ['/api', '/api/x', '/assets/a.css', '/healthz', '/API', '/robots.txt']) assert.equal(err(raw), 'invalid-path', raw);
  assert.equal(ok('/notas/api'), '/notas/api');
  assert.equal(ok('/apis'), '/apis');
});

test('limite de níveis', () => {
  const ten = '/' + Array.from({ length: 10 }, (_, i) => `n${i}`).join('/');
  assert.equal(ok(ten), ten);
  assert.equal(err(ten + '/extra'), 'nesting-limit-reached');
  assert.equal(err('/a/b/c', { maxDepth: 2 }), 'nesting-limit-reached');
});

test('encodePath é o inverso de parsePath', () => {
  for (const p of ['/notas', '/olá mundo/sub', '/100%/a?b#c']) {
    assert.equal(parsePath(encodePath(p)).path, p);
  }
});

test('regra de lastModified: nunca repete nem recua', () => {
  assert.equal(nextLastModified(0, 1000), 1000);
  assert.equal(nextLastModified(999, 1000), 1000);
  assert.equal(nextLastModified(1000, 1000), 1001);
  assert.equal(nextLastModified(5000, 1000), 5001); // relógio atrasado
});
