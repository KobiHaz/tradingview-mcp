import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tabExists, valuesPayload } from '../src/sheets-writer';

test('tabExists finds a tab by title', () => {
  const meta = { sheets: [{ properties: { title: 'Semis' } }, { properties: { title: 'Energy' } }] };
  assert.equal(tabExists(meta, 'Energy'), true);
  assert.equal(tabExists(meta, 'Missing'), false);
});

test('tabExists handles empty/missing metadata', () => {
  assert.equal(tabExists({}, 'X'), false);
});

test('valuesPayload writes a header then one symbol per row', () => {
  const out = valuesPayload('Semis', ['NASDAQ:NVDA', 'NASDAQ:AMD']);
  assert.equal(out.range, "'Semis'!A1");
  assert.deepEqual(out.values, [['Symbol'], ['NASDAQ:NVDA'], ['NASDAQ:AMD']]);
});
