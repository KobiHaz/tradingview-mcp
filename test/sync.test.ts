import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSync } from '../src/sync';
import type { Source } from '../src/sources';

const sources: Source[] = [
  { name: 'A', shareUrl: 'uA', tab: 'A' },
  { name: 'B', shareUrl: 'uB', tab: 'B' },
];

test('runSync writes each list and reports counts', async () => {
  const writes: Record<string, string[]> = {};
  const res = await runSync(sources, {
    sheetId: 'SHEET',
    readList: async (url) => (url === 'uA' ? ['NVDA'] : ['XOM', 'CVX']),
    writeTab: async (_id, tab, syms) => { writes[tab] = syms; },
    log: () => {},
  });
  assert.deepEqual(writes, { A: ['NVDA'], B: ['XOM', 'CVX'] });
  assert.equal(res.failures, 0);
  assert.equal(res.written, 2);
});

test('runSync skips the write when a read returns zero symbols', async () => {
  let wrote = false;
  const res = await runSync([sources[0]], {
    sheetId: 'SHEET',
    readList: async () => [],
    writeTab: async () => { wrote = true; },
    log: () => {},
  });
  assert.equal(wrote, false);
  assert.equal(res.skipped, 1);
});

test('runSync continues past a failing list and counts the failure', async () => {
  const written: string[] = [];
  const res = await runSync(sources, {
    sheetId: 'SHEET',
    readList: async (url) => { if (url === 'uA') throw new Error('boom'); return ['XOM']; },
    writeTab: async (_id, tab) => { written.push(tab); },
    log: () => {},
  });
  assert.deepEqual(written, ['B']);
  assert.equal(res.failures, 1);
});
