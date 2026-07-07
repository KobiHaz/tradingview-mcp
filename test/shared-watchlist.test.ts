import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractSymbols } from '../src/shared-watchlist';

// Mimics the relevant slice of the real page's window.initData.
const FIXTURE = `<script>window.initData = {"name":"Semis",` +
  `"symbols":["###SEMI - CAP","NASDAQ:NVDA","NASDAQ:AMD","KRX:000660","NYSE:BRK.B"],` +
  `"other":true};</script>`;

test('extractSymbols returns exchange-qualified symbols', () => {
  assert.deepEqual(extractSymbols(FIXTURE),
    ['NASDAQ:NVDA', 'NASDAQ:AMD', 'KRX:000660', 'NYSE:BRK.B']);
});

test('extractSymbols drops section-header rows', () => {
  assert.ok(!extractSymbols(FIXTURE).includes('###SEMI - CAP'));
});

test('extractSymbols throws when symbols are absent', () => {
  assert.throws(() => extractSymbols('<html>no init data here</html>'),
    /could not find symbols/i);
});
