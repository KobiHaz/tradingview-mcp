import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSources, loadSources } from '../src/sources';

test('parseSources accepts a valid array', () => {
  const out = parseSources(JSON.stringify([
    { name: 'Semis', shareUrl: 'https://www.tradingview.com/watchlists/123/', tab: 'Semis' },
  ]));
  assert.equal(out.length, 1);
  assert.equal(out[0].tab, 'Semis');
});

test('parseSources rejects non-array', () => {
  assert.throws(() => parseSources('{}'), /must be a JSON array/i);
});

test('parseSources rejects missing fields', () => {
  assert.throws(() => parseSources(JSON.stringify([{ name: 'x', tab: 'x' }])), /shareUrl/i);
});

test('parseSources rejects duplicate tabs', () => {
  const json = JSON.stringify([
    { name: 'A', shareUrl: 'u1', tab: 'Same' },
    { name: 'B', shareUrl: 'u2', tab: 'Same' },
  ]);
  assert.throws(() => parseSources(json), /duplicate tab/i);
});

test('loadSources throws a clear error when file is missing', () => {
  assert.throws(
    () => loadSources(join(mkdtempSync(join(tmpdir(), 's-')), 'nope.json')),
    /watchlist-sources/i
  );
});
