import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tvInterval } from '../src/driver';

test('tvInterval maps friendly forms to TV codes', () => {
  assert.equal(tvInterval('1D'), 'D');
  assert.equal(tvInterval('1W'), 'W');
  assert.equal(tvInterval('M'), 'M');
  assert.equal(tvInterval('1H'), '60');
  assert.equal(tvInterval('4H'), '240');
});
test('tvInterval passes through unknown values (incl. ambiguous 1M)', () => {
  assert.equal(tvInterval('1M'), '1M');
  assert.equal(tvInterval('weird'), 'WEIRD');
});
