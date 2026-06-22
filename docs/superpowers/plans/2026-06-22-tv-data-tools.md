# TradingView Data Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a numeric-data layer to tradingview-mcp — market screener, multi-symbol quotes, multi-timeframe indicators, and symbol search — so the model can reason over numbers, not just screenshots.

**Architecture:** A new pure-network module `src/scanner.ts` wraps two public TradingView endpoints (`scanner.tradingview.com/{market}/scan` and `symbol-search.tradingview.com`). It uses Node's global `fetch` — **no Playwright, no logged-in profile, no browser mutex**. Four new MCP tools call this module directly, bypassing the existing browser lock so they are fast and independent of the chart page. The server becomes hybrid: actions+pixels via the browser, numbers via the API.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk`, Node 24 global `fetch`, `node:test` + `node:assert/strict` (existing test runner: `npm test` → `tsx --test test/*.test.ts`).

---

## Relevance & Prioritization (grounded in the codebase)

Verified against the live endpoints (every column/endpoint below returned real data on 2026-06-22) and against `smart-volume-radar` (`~/.gemini/antigravity/projects/smart-volume-radar`).

**Key finding about the radar:** it pulls technicals from **Finnhub**, delivers to **Telegram**, and scans only a **fixed Google-Sheet watchlist** — it has **no market-wide discovery**. Its core metric is **RVOL** (`relative_volume_10d_calc`, verified present on the scanner). This reorders priority by *relevance*, not just feasibility:

| Pri | Tool | Why it ranks here | Relevance to radar |
|-----|------|-------------------|--------------------|
| **P1** | `tv_screener` | Adds a capability the radar **fundamentally lacks**: find NEW symbols across the whole market by RVOL/RSI/volume. Radar already has Telegram to act on hits. | 🔥 Highest — turns "watch my list" into "discover candidates" |
| **P2** | `tv_quote` | Breadth snapshot incl. **RVOL** — a second, independent source to cross-validate Finnhub. | High — cross-validation + RVOL parity |
| **P3** | `tv_indicators` | Depth: multi-timeframe RSI/MACD/BB/Recommend for one symbol. Finnhub doesn't give multi-TF easily. | Medium-high — deep-dive enrichment |
| **P4** | `tv_search` | Resolve/validate a ticker → `EXCHANGE:SYMBOL`. Cheap; de-risks the other tools (and existing screenshot/watchlist tools) against bad symbols. | Medium — utility/glue |
| **P1.5** | `tv_watchlist_data` | **User-requested capstone.** Enrich every symbol in a list (TV watchlist / direct array / Google Sheet CSV) with quote or indicator data in one scanner call. | 🔥 Very high — bridges the radar's **exact Google-Sheet source** to the data engine |

Build order = P1→P4, then P1.5 (Tasks 8–10) which depends on `quote`/`indicators`/`searchSymbol`. Each task produces working, tested software on its own; you can stop after any task and have shippable value.

**Verified gotcha (2026-06-22):** the scanner **silently drops bare tickers** — `{"tickers":["AAPL"]}` returns `totalCount:0`; only `NASDAQ:AAPL` resolves. Watchlists and Sheets supply bare symbols, so `tv_watchlist_data` must qualify them first (via `tv_search`) or read the already-qualified `data-symbol-full` from the TV DOM.

---

## File Structure

- **Create** `src/scanner.ts` — the entire data layer. Pure helpers (testable without network) + thin `fetch` wrappers + four high-level functions (`screener`, `quote`, `indicators`, `searchSymbol`). One responsibility: talk to TradingView's data endpoints and return clean JSON.
- **Create** `test/scanner.test.ts` — unit tests for the pure helpers (market inference, operator mapping, column/timeframe building, response parsing). Network functions are validated by manual `curl` checks documented in each task (the endpoints were already verified live).
- **Modify** `src/server.ts` — register the four new tools in `TOOLS`, and add a data-tool branch that runs **before** `getPage()`/`ensureReady()` so these tools never touch the browser or the lock.
- **Modify** `README.md` — document the four tools and that they need no login.

### Verified endpoint contracts (do not re-derive — these were tested live)

**Scan endpoint** — `POST https://scanner.tradingview.com/{market}/scan`, header `Content-Type: application/json`.

Quote body (symbols → columns):
```json
{ "symbols": { "tickers": ["NASDAQ:AAPL"] }, "columns": ["close","RSI"] }
```
Screener body (filter → ranked rows):
```json
{ "filter": [{"left":"RSI","operation":"less","right":30},
             {"left":"volume","operation":"greater","right":1000000}],
  "options": {"lang":"en"},
  "sort": {"sortBy":"volume","sortOrder":"desc"},
  "range": [0, 30],
  "columns": ["name","close","RSI","volume"] }
```
Response (both): `{ "totalCount": N, "data": [ { "s": "NASDAQ:AAPL", "d": [<values in column order>] } ] }`.

**Verified column names:** `name`, `close`, `change` (percent), `volume`, `relative_volume_10d_calc` (RVOL), `average_volume_10d_calc`, `RSI`, `MACD.macd`, `MACD.signal`, `BB.upper`, `BB.lower`, `SMA20`, `SMA50`, `SMA200`, `EMA20`, `Recommend.All`. Multi-timeframe via suffix: `RSI|60`, `close|15`, `change|240` (daily = **no** suffix). Unknown column → returns `null` for that cell (does not error).

**Verified markets:** `america` (NASDAQ/NYSE/AMEX), `crypto` (BINANCE/COINBASE/etc.).

**Symbol search** — `GET https://symbol-search.tradingview.com/symbol_search/?text={q}&hl=1&lang=en&domain=production`, headers `Origin: https://www.tradingview.com`, `Referer: https://www.tradingview.com/`. Returns an array of `{symbol, description (HTML <em> tags), type, exchange, currency_code, country, ...}`.

---

## Task 1: Pure helpers — market inference & operator mapping

**Files:**
- Create: `src/scanner.ts`
- Test: `test/scanner.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/scanner.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferMarket, normalizeOp } from '../src/scanner';

test('inferMarket maps known exchange prefixes', () => {
  assert.equal(inferMarket('NASDAQ:AAPL'), 'america');
  assert.equal(inferMarket('NYSE:T'), 'america');
  assert.equal(inferMarket('AMEX:SPY'), 'america');
  assert.equal(inferMarket('BINANCE:BTCUSDT'), 'crypto');
  assert.equal(inferMarket('COINBASE:ETHUSD'), 'crypto');
});

test('inferMarket falls back to america for bare/unknown symbols', () => {
  assert.equal(inferMarket('AAPL'), 'america');
  assert.equal(inferMarket('WEIRD:THING'), 'america');
});

test('normalizeOp maps friendly operators to TV operations', () => {
  assert.equal(normalizeOp('gt'), 'greater');
  assert.equal(normalizeOp('greater'), 'greater');
  assert.equal(normalizeOp('lt'), 'less');
  assert.equal(normalizeOp('gte'), 'egreater');
  assert.equal(normalizeOp('lte'), 'eless');
  assert.equal(normalizeOp('eq'), 'equal');
  assert.equal(normalizeOp('between'), 'in_range');
});

test('normalizeOp throws on unknown operator', () => {
  assert.throws(() => normalizeOp('explode'), /unknown operator/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/scanner'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/scanner.ts
// Pure data layer for TradingView's public endpoints. No Playwright, no login.

const CRYPTO_EXCHANGES = new Set([
  'BINANCE', 'COINBASE', 'KUCOIN', 'BYBIT', 'OKX', 'KRAKEN', 'BITSTAMP', 'BITFINEX',
]);

/** Infer the scanner market path from a symbol's exchange prefix. */
export function inferMarket(symbol: string): string {
  const prefix = symbol.includes(':') ? symbol.split(':')[0].toUpperCase() : '';
  if (CRYPTO_EXCHANGES.has(prefix)) return 'crypto';
  return 'america';
}

const OP_MAP: Record<string, string> = {
  gt: 'greater', greater: 'greater',
  lt: 'less', less: 'less',
  gte: 'egreater', egreater: 'egreater',
  lte: 'eless', eless: 'eless',
  eq: 'equal', equal: 'equal',
  between: 'in_range', in_range: 'in_range',
};

/** Map a friendly comparison operator to a TradingView scanner operation. */
export function normalizeOp(op: string): string {
  const tv = OP_MAP[op.trim().toLowerCase()];
  if (!tv) throw new Error(`unknown operator: ${op}`);
  return tv;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (all four new tests + existing `driver.test.ts`).

- [ ] **Step 5: Commit**

```bash
git add src/scanner.ts test/scanner.test.ts
git commit -m "feat(scanner): market inference + operator mapping helpers"
```

---

## Task 2: Pure helpers — column aliases, timeframe suffixes, response parser

**Files:**
- Modify: `src/scanner.ts`
- Test: `test/scanner.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// append to test/scanner.test.ts
import { resolveColumn, tfSuffix, buildIndicatorColumns, parseScanResponse } from '../src/scanner';

test('resolveColumn maps friendly indicator names to TV columns', () => {
  assert.equal(resolveColumn('rsi'), 'RSI');
  assert.equal(resolveColumn('macd'), 'MACD.macd');
  assert.equal(resolveColumn('rvol'), 'relative_volume_10d_calc');
  assert.equal(resolveColumn('bb_upper'), 'BB.upper');
  assert.equal(resolveColumn('sma50'), 'SMA50');
  assert.equal(resolveColumn('recommend'), 'Recommend.All');
});

test('resolveColumn passes through already-valid TV columns', () => {
  assert.equal(resolveColumn('Recommend.All'), 'Recommend.All');
  assert.equal(resolveColumn('close'), 'close');
});

test('tfSuffix returns empty for daily and a |code for intraday/higher', () => {
  assert.equal(tfSuffix('1d'), '');
  assert.equal(tfSuffix('daily'), '');
  assert.equal(tfSuffix('1h'), '|60');
  assert.equal(tfSuffix('15m'), '|15');
  assert.equal(tfSuffix('4h'), '|240');
  assert.equal(tfSuffix('1w'), '|1W');
});

test('buildIndicatorColumns crosses indicators with timeframes', () => {
  assert.deepEqual(
    buildIndicatorColumns(['rsi', 'macd'], ['1d', '1h']),
    ['RSI', 'MACD.macd', 'RSI|60', 'MACD.macd|60']
  );
});

test('parseScanResponse zips columns with row values into objects', () => {
  const json = { totalCount: 1, data: [{ s: 'NASDAQ:AAPL', d: [298.01, 50.9] }] };
  assert.deepEqual(parseScanResponse(json, ['close', 'RSI']), [
    { symbol: 'NASDAQ:AAPL', close: 298.01, RSI: 50.9 },
  ]);
});

test('parseScanResponse tolerates empty/missing data', () => {
  assert.deepEqual(parseScanResponse({ totalCount: 0, data: [] }, ['close']), []);
  assert.deepEqual(parseScanResponse({}, ['close']), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `resolveColumn`/`tfSuffix`/`buildIndicatorColumns`/`parseScanResponse` not exported.

- [ ] **Step 3: Write minimal implementation**

```typescript
// append to src/scanner.ts

const COLUMN_ALIASES: Record<string, string> = {
  rsi: 'RSI',
  macd: 'MACD.macd', macd_signal: 'MACD.signal',
  sma20: 'SMA20', sma50: 'SMA50', sma200: 'SMA200', ema20: 'EMA20',
  bb_upper: 'BB.upper', bb_lower: 'BB.lower',
  rvol: 'relative_volume_10d_calc', avg_volume: 'average_volume_10d_calc',
  recommend: 'Recommend.All',
  close: 'close', change: 'change', volume: 'volume', name: 'name',
};

/** Map a friendly indicator/column name to a TV column; pass through if already valid. */
export function resolveColumn(name: string): string {
  return COLUMN_ALIASES[name.trim().toLowerCase()] ?? name;
}

const TF_SUFFIX: Record<string, string> = {
  '1m': '|1', '1': '|1',
  '5m': '|5', '5': '|5',
  '15m': '|15', '15': '|15',
  '30m': '|30', '30': '|30',
  '1h': '|60', '60': '|60',
  '2h': '|120', '120': '|120',
  '4h': '|240', '240': '|240',
  '1d': '', d: '', daily: '',
  '1w': '|1W', w: '|1W', weekly: '|1W',
  '1mo': '|1M', monthly: '|1M',
};

/** TradingView column suffix for a timeframe ('' = daily, the endpoint default). */
export function tfSuffix(tf: string): string {
  const key = tf.trim().toLowerCase();
  if (!(key in TF_SUFFIX)) throw new Error(`unknown timeframe: ${tf}`);
  return TF_SUFFIX[key];
}

/** Cross a list of indicators with a list of timeframes into TV column names. */
export function buildIndicatorColumns(indicators: string[], timeframes: string[]): string[] {
  const cols: string[] = [];
  for (const tf of timeframes) {
    const suffix = tfSuffix(tf);
    for (const ind of indicators) cols.push(resolveColumn(ind) + suffix);
  }
  return cols;
}

export interface ScanRow {
  symbol: string;
  [column: string]: string | number | null;
}

/** Zip the response's column-ordered value arrays back into named objects. */
export function parseScanResponse(json: unknown, columns: string[]): ScanRow[] {
  const data = (json as { data?: Array<{ s: string; d: unknown[] }> })?.data;
  if (!Array.isArray(data)) return [];
  return data.map((row) => {
    const obj: ScanRow = { symbol: row.s };
    columns.forEach((col, i) => {
      obj[col] = (row.d?.[i] ?? null) as string | number | null;
    });
    return obj;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/scanner.ts test/scanner.test.ts
git commit -m "feat(scanner): column aliases, timeframe suffixes, response parser"
```

---

## Task 3: Network core `scan()` + `quote()` (P2 tool backend)

**Files:**
- Modify: `src/scanner.ts`
- Test: `test/scanner.test.ts`

- [ ] **Step 1: Write the failing test** (pure body-builder only; `scan`/`quote` are network and verified by manual curl in Step 4)

```typescript
// append to test/scanner.test.ts
import { buildQuoteBody, QUOTE_COLUMNS } from '../src/scanner';

test('buildQuoteBody normalizes tickers and uses default columns', () => {
  const body = buildQuoteBody(['nasdaq:aapl', 'NVDA']);
  assert.deepEqual(body.symbols.tickers, ['NASDAQ:AAPL', 'NVDA']);
  assert.deepEqual(body.columns, QUOTE_COLUMNS);
});

test('QUOTE_COLUMNS includes RVOL (the radar core metric)', () => {
  assert.ok(QUOTE_COLUMNS.includes('relative_volume_10d_calc'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `buildQuoteBody`/`QUOTE_COLUMNS` not exported.

- [ ] **Step 3: Write minimal implementation**

```typescript
// append to src/scanner.ts

const SCAN_BASE = 'https://scanner.tradingview.com';

/** Low-level POST to the scanner. Returns parsed JSON or throws on HTTP error. */
export async function scan(market: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${SCAN_BASE}/${market}/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`scanner HTTP ${res.status} for market "${market}"`);
  return res.json();
}

export const QUOTE_COLUMNS = [
  'name', 'close', 'change', 'volume',
  'relative_volume_10d_calc', 'average_volume_10d_calc',
  'RSI', 'Recommend.All',
];

export interface QuoteBody {
  symbols: { tickers: string[] };
  columns: string[];
}

/** Build the scan request body for a multi-symbol quote. */
export function buildQuoteBody(symbols: string[], columns: string[] = QUOTE_COLUMNS): QuoteBody {
  return {
    symbols: { tickers: symbols.map((s) => s.trim().toUpperCase()) },
    columns,
  };
}

/** Snapshot one or more symbols. Market inferred from the first symbol unless given. */
export async function quote(symbols: string[], market?: string): Promise<ScanRow[]> {
  if (symbols.length === 0) return [];
  const mkt = market ?? inferMarket(symbols[0]);
  const body = buildQuoteBody(symbols);
  const json = await scan(mkt, body);
  return parseScanResponse(json, body.columns);
}
```

- [ ] **Step 4: Run test to verify it passes + manual network smoke check**

Run: `npm test`
Expected: PASS.

Manual smoke check (network — confirms `quote()` end-to-end):
```bash
npx tsx -e "import('./src/scanner.ts').then(async m => console.log(await m.quote(['NASDAQ:AAPL','NASDAQ:NVDA'])))"
```
Expected: an array of 2 objects, each with `symbol`, `close`, `RSI`, `relative_volume_10d_calc`, etc. (non-null numbers).

- [ ] **Step 5: Commit**

```bash
git add src/scanner.ts test/scanner.test.ts
git commit -m "feat(scanner): scan() core + quote() with RVOL columns"
```

---

## Task 4: `screener()` (P1 tool backend)

**Files:**
- Modify: `src/scanner.ts`
- Test: `test/scanner.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// append to test/scanner.test.ts
import { buildScreenerBody } from '../src/scanner';

test('buildScreenerBody maps friendly filters and defaults', () => {
  const body = buildScreenerBody({
    filters: [
      { field: 'rvol', op: 'gt', value: 2 },
      { field: 'rsi', op: 'lt', value: 30 },
    ],
  });
  assert.deepEqual(body.filter, [
    { left: 'relative_volume_10d_calc', operation: 'greater', right: 2 },
    { left: 'RSI', operation: 'less', right: 30 },
  ]);
  assert.deepEqual(body.range, [0, 30]); // default limit
  assert.equal(body.sort.sortBy, 'volume'); // default sort
  assert.equal(body.sort.sortOrder, 'desc');
  assert.ok(body.columns.includes('name'));
});

test('buildScreenerBody honors custom sort, limit, and between-ranges', () => {
  const body = buildScreenerBody({
    filters: [{ field: 'rsi', op: 'between', value: [40, 60] }],
    sort: { field: 'rvol', order: 'asc' },
    limit: 5,
  });
  assert.deepEqual(body.filter[0], { left: 'RSI', operation: 'in_range', right: [40, 60] });
  assert.deepEqual(body.range, [0, 5]);
  assert.equal(body.sort.sortBy, 'relative_volume_10d_calc');
  assert.equal(body.sort.sortOrder, 'asc');
});

test('buildScreenerBody caps limit at 100', () => {
  const body = buildScreenerBody({ filters: [], limit: 9999 });
  assert.deepEqual(body.range, [0, 100]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `buildScreenerBody` not exported.

- [ ] **Step 3: Write minimal implementation**

```typescript
// append to src/scanner.ts

export interface ScreenerFilter {
  field: string;
  op: string;
  value: number | number[];
}
export interface ScreenerOptions {
  filters: ScreenerFilter[];
  market?: string;
  sort?: { field: string; order: 'asc' | 'desc' };
  columns?: string[];
  limit?: number;
}

export const SCREENER_COLUMNS = [
  'name', 'close', 'change', 'volume', 'relative_volume_10d_calc', 'RSI',
];

export interface ScreenerBody {
  filter: Array<{ left: string; operation: string; right: number | number[] }>;
  options: { lang: string };
  sort: { sortBy: string; sortOrder: 'asc' | 'desc' };
  range: [number, number];
  columns: string[];
}

/** Build the scan request body for a market screener. */
export function buildScreenerBody(opts: ScreenerOptions): ScreenerBody {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const sortField = opts.sort?.field ? resolveColumn(opts.sort.field) : 'volume';
  return {
    filter: opts.filters.map((f) => ({
      left: resolveColumn(f.field),
      operation: normalizeOp(f.op),
      right: f.value,
    })),
    options: { lang: 'en' },
    sort: { sortBy: sortField, sortOrder: opts.sort?.order ?? 'desc' },
    range: [0, limit],
    columns: opts.columns ?? SCREENER_COLUMNS,
  };
}

/** Run a market screener. Returns { totalCount, rows }. */
export async function screener(
  opts: ScreenerOptions
): Promise<{ totalCount: number; rows: ScanRow[] }> {
  const body = buildScreenerBody(opts);
  const json = await scan(opts.market ?? 'america', body);
  const totalCount = (json as { totalCount?: number })?.totalCount ?? 0;
  return { totalCount, rows: parseScanResponse(json, body.columns) };
}
```

- [ ] **Step 4: Run test to verify it passes + manual network smoke check**

Run: `npm test`
Expected: PASS.

Manual smoke check:
```bash
npx tsx -e "import('./src/scanner.ts').then(async m => console.log(await m.screener({filters:[{field:'rvol',op:'gt',value:3},{field:'volume',op:'gt',value:1000000}],limit:5})))"
```
Expected: `{ totalCount: <number>, rows: [ {symbol, name, close, relative_volume_10d_calc>3, ...}, ... ] }`.

- [ ] **Step 5: Commit**

```bash
git add src/scanner.ts test/scanner.test.ts
git commit -m "feat(scanner): screener() with friendly filters + sort/limit"
```

---

## Task 5: `indicators()` (P3) + `searchSymbol()` (P4) backends

**Files:**
- Modify: `src/scanner.ts`
- Test: `test/scanner.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// append to test/scanner.test.ts
import { parseSearchResults } from '../src/scanner';

test('parseSearchResults strips <em> tags and keeps key fields', () => {
  const raw = [
    { symbol: 'AAPL', description: '<em>Apple</em> Inc.', type: 'stock',
      exchange: 'NASDAQ', currency_code: 'USD', country: 'US' },
  ];
  assert.deepEqual(parseSearchResults(raw), [
    { symbol: 'AAPL', tvSymbol: 'NASDAQ:AAPL', description: 'Apple Inc.',
      type: 'stock', exchange: 'NASDAQ', currency: 'USD', country: 'US' },
  ]);
});

test('parseSearchResults tolerates missing fields and non-arrays', () => {
  assert.deepEqual(parseSearchResults([{ symbol: 'X' }]), [
    { symbol: 'X', tvSymbol: 'X', description: '', type: '', exchange: '',
      currency: '', country: '' },
  ]);
  assert.deepEqual(parseSearchResults(null), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `parseSearchResults` not exported.

- [ ] **Step 3: Write minimal implementation**

```typescript
// append to src/scanner.ts

/** Per-symbol indicator matrix across timeframes. Columns named like RSI|60. */
export async function indicators(
  symbol: string,
  inds: string[],
  timeframes: string[],
  market?: string
): Promise<ScanRow | null> {
  const columns = buildIndicatorColumns(inds, timeframes);
  const body = { symbols: { tickers: [symbol.trim().toUpperCase()] }, columns };
  const json = await scan(market ?? inferMarket(symbol), body);
  const rows = parseScanResponse(json, columns);
  return rows[0] ?? null;
}

const SEARCH_BASE = 'https://symbol-search.tradingview.com/symbol_search/';

export interface SearchResult {
  symbol: string;
  tvSymbol: string;
  description: string;
  type: string;
  exchange: string;
  currency: string;
  country: string;
}

/** Normalize raw symbol-search JSON: strip <em> tags, build EXCHANGE:SYMBOL. */
export function parseSearchResults(raw: unknown): SearchResult[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((r: Record<string, unknown>) => {
    const symbol = String(r.symbol ?? '');
    const exchange = String(r.exchange ?? '');
    return {
      symbol,
      tvSymbol: exchange ? `${exchange}:${symbol}` : symbol,
      description: String(r.description ?? '').replace(/<\/?em>/g, ''),
      type: String(r.type ?? ''),
      exchange,
      currency: String(r.currency_code ?? ''),
      country: String(r.country ?? ''),
    };
  });
}

/** Resolve a free-text query to candidate TradingView symbols. */
export async function searchSymbol(query: string): Promise<SearchResult[]> {
  const url = `${SEARCH_BASE}?text=${encodeURIComponent(query)}&hl=1&lang=en&domain=production`;
  const res = await fetch(url, {
    headers: {
      Origin: 'https://www.tradingview.com',
      Referer: 'https://www.tradingview.com/',
    },
  });
  if (!res.ok) throw new Error(`symbol-search HTTP ${res.status}`);
  return parseSearchResults(await res.json());
}
```

- [ ] **Step 4: Run test to verify it passes + manual network smoke check**

Run: `npm test`
Expected: PASS.

Manual smoke checks:
```bash
npx tsx -e "import('./src/scanner.ts').then(async m => console.log(await m.indicators('NASDAQ:AAPL',['rsi','macd'],['1d','1h'])))"
npx tsx -e "import('./src/scanner.ts').then(async m => console.log((await m.searchSymbol('apple')).slice(0,3)))"
```
Expected: indicators → one object with keys `RSI`, `MACD.macd`, `RSI|60`, `MACD.macd|60`; search → up to 3 results with `tvSymbol` like `NASDAQ:AAPL`.

- [ ] **Step 5: Commit**

```bash
git add src/scanner.ts test/scanner.test.ts
git commit -m "feat(scanner): indicators() multi-timeframe + searchSymbol()"
```

---

## Task 6: Wire the four tools into the MCP server (no browser, no lock)

**Files:**
- Modify: `src/server.ts`

**Why a separate branch:** the existing handler wraps everything in `withLock` and calls `getPage()` first (launches the browser). Data tools must NOT do either — they are pure network. Add an early branch in the `CallToolRequestSchema` handler that handles data tools and returns before the browser path. Keep it inside `withLock`'s callback is **not** required, but to avoid changing the outer structure we add the branch at the very top of the try block, before `const page = await getPage()`.

- [ ] **Step 1: Add the import**

In `src/server.ts`, after the existing `driver` import (line ~12), add:

```typescript
import { screener, quote, indicators, searchSymbol } from './scanner';
```

- [ ] **Step 2: Register the four tools in the `TOOLS` array**

Add these objects to the `TOOLS` array in `src/server.ts` (after the existing `tv_session_status` entry, before the closing `];`):

```typescript
  { name: 'tv_screener', description: 'Scan the market for symbols matching technical filters (no login needed). Fields: rvol, rsi, volume, close, change, macd, sma20/50/200, recommend. Ops: gt, lt, gte, lte, eq, between. Returns ranked rows.',
    inputSchema: { type: 'object', properties: {
      filters: { type: 'array', items: { type: 'object', properties: {
        field: { type: 'string' }, op: { type: 'string' },
        value: {} }, required: ['field', 'op', 'value'], additionalProperties: false } },
      market: { type: 'string', description: 'america (default) or crypto' },
      sort: { type: 'object', properties: { field: { type: 'string' }, order: { type: 'string', enum: ['asc', 'desc'] } }, additionalProperties: false },
      limit: { type: 'number' } },
      required: ['filters'], additionalProperties: false } },
  { name: 'tv_quote', description: 'Snapshot one or more symbols (price, change%, volume, RVOL, RSI, recommendation). No login needed.',
    inputSchema: { type: 'object', properties: {
      symbols: { type: 'array', items: { type: 'string' }, minItems: 1 },
      market: { type: 'string' } },
      required: ['symbols'], additionalProperties: false } },
  { name: 'tv_indicators', description: 'Technical indicator values for one symbol across timeframes. Indicators: rsi, macd, sma20/50/200, ema20, bb_upper, bb_lower, recommend. Timeframes: 1m,5m,15m,30m,1h,4h,1d,1w. No login needed.',
    inputSchema: { type: 'object', properties: {
      symbol: { type: 'string' },
      indicators: { type: 'array', items: { type: 'string' }, minItems: 1 },
      timeframes: { type: 'array', items: { type: 'string' }, minItems: 1 },
      market: { type: 'string' } },
      required: ['symbol', 'indicators', 'timeframes'], additionalProperties: false } },
  { name: 'tv_search', description: 'Resolve a free-text query (company name or ticker) to TradingView symbols (EXCHANGE:SYMBOL). No login needed.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } },
```

- [ ] **Step 3: Add the data-tool branch in the request handler**

In `src/server.ts`, inside the `CallToolRequestSchema` handler's `try` block, **immediately after** `const args ...` and **before** `const page = await getPage();`, insert:

```typescript
    // Data tools — pure network (no browser, no login, no lock dependency).
    if (name === 'tv_screener') {
      const out = await screener({
        filters: (args.filters as { field: string; op: string; value: number | number[] }[]) || [],
        market: args.market as string | undefined,
        sort: args.sort as { field: string; order: 'asc' | 'desc' } | undefined,
        limit: args.limit as number | undefined,
      });
      return text(JSON.stringify(out));
    }
    if (name === 'tv_quote') {
      const out = await quote((args.symbols as string[]) || [], args.market as string | undefined);
      return text(JSON.stringify(out));
    }
    if (name === 'tv_indicators') {
      const out = await indicators(
        String(args.symbol || ''),
        (args.indicators as string[]) || [],
        (args.timeframes as string[]) || [],
        args.market as string | undefined
      );
      if (!out) return errText(`no data for symbol: ${args.symbol}`);
      return text(JSON.stringify(out));
    }
    if (name === 'tv_search') {
      const out = await searchSymbol(String(args.query || ''));
      return text(JSON.stringify(out));
    }
```

Note: these run inside the existing `withLock(...)` wrapper. That is acceptable (they're fast and the lock just serializes them harmlessly), and it avoids restructuring the handler. They return **before** `getPage()`, so the browser never launches for a data-only call.

- [ ] **Step 4: Typecheck + tests + manual MCP smoke check**

Run: `npm run typecheck`
Expected: no errors.

Run: `npm test`
Expected: PASS (existing + scanner tests).

Manual: start the server and confirm it lists 9 tools without launching a browser:
```bash
npx tsx -e "import('./src/scanner.ts').then(()=>console.log('module loads'))"
```
Expected: `module loads` (sanity that imports resolve; full MCP handshake is verified by reloading the client session).

- [ ] **Step 5: Commit**

```bash
git add src/server.ts
git commit -m "feat(server): register tv_screener/quote/indicators/search data tools"
```

---

## Task 7: Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document the new tools**

Add a section to `README.md` describing the four data tools. Insert after the existing tools list:

```markdown
## Data tools (no login required)

These hit TradingView's public endpoints directly — they work even when `tv_session_status` reports `loggedIn:false`.

| Tool | Purpose | Example |
|------|---------|---------|
| `tv_screener` | Market-wide scan by technical filters | `{ "filters": [{"field":"rvol","op":"gt","value":2}, {"field":"rsi","op":"lt","value":30}], "limit": 20 }` |
| `tv_quote` | Snapshot (price, change%, volume, RVOL, RSI, recommendation) | `{ "symbols": ["NASDAQ:AAPL","NASDAQ:NVDA"] }` |
| `tv_indicators` | Indicator matrix across timeframes | `{ "symbol":"NASDAQ:AAPL", "indicators":["rsi","macd"], "timeframes":["1d","1h"] }` |
| `tv_search` | Resolve name/ticker → `EXCHANGE:SYMBOL` | `{ "query": "apple" }` |

**Filter fields:** `rvol`, `rsi`, `volume`, `close`, `change`, `macd`, `sma20`/`sma50`/`sma200`, `recommend`.
**Operators:** `gt`, `lt`, `gte`, `lte`, `eq`, `between` (value = `[min,max]`).
**Markets:** `america` (default), `crypto`. Inferred from the symbol prefix when omitted.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: document tv_screener/quote/indicators/search data tools"
```

---

## Task 8: Google Sheet CSV source — `fetchSheetSymbols()`

**Files:**
- Modify: `src/scanner.ts`
- Test: `test/scanner.test.ts`

**Grounding:** the radar fetches a *public* Google Sheet via CSV export (`https://docs.google.com/spreadsheets/d/{id}/export?format=csv`), column A = symbol. We replicate that — pure `fetch`, no Google API, no auth. The user may pass either a raw sheet ID or a full sheet URL.

- [ ] **Step 1: Write the failing test**

```typescript
// append to test/scanner.test.ts
import { sheetIdFromInput, parseSheetCsv } from '../src/scanner';

test('sheetIdFromInput extracts the id from a full URL or passes an id through', () => {
  assert.equal(
    sheetIdFromInput('https://docs.google.com/spreadsheets/d/1AbcDEF_ghi-JKL2345678901234567890/edit#gid=0'),
    '1AbcDEF_ghi-JKL2345678901234567890'
  );
  assert.equal(sheetIdFromInput('1AbcDEF_ghi-JKL2345678901234567890'), '1AbcDEF_ghi-JKL2345678901234567890');
});

test('parseSheetCsv takes column A, skips a header row and blanks', () => {
  const csv = 'Symbol,Sector\nAAPL,Tech\nNVDA,Tech\n\nMETA,Comm';
  assert.deepEqual(parseSheetCsv(csv), ['AAPL', 'NVDA', 'META']);
});

test('parseSheetCsv keeps first row when it is not a header', () => {
  assert.deepEqual(parseSheetCsv('AAPL\nNVDA'), ['AAPL', 'NVDA']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `sheetIdFromInput`/`parseSheetCsv` not exported.

- [ ] **Step 3: Write minimal implementation**

```typescript
// append to src/scanner.ts

const SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/{id}/export?format=csv';

/** Accept a raw sheet id or any Google Sheets URL; return the id. */
export function sheetIdFromInput(input: string): string {
  const m = input.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,60})/);
  return m ? m[1] : input.trim();
}

/** Parse CSV → first-column symbols, skipping a header row and blank lines. */
export function parseSheetCsv(csv: string): string[] {
  const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const cells = lines.map((l) => l.split(',')[0].replace(/^"|"$/g, '').trim());
  if (cells.length && /^symbol$/i.test(cells[0])) cells.shift(); // drop header
  return cells.filter(Boolean);
}

/** Fetch a public Google Sheet's first column as a symbol list. */
export async function fetchSheetSymbols(input: string): Promise<string[]> {
  const id = sheetIdFromInput(input);
  const res = await fetch(SHEET_CSV_URL.replace('{id}', encodeURIComponent(id)));
  if (!res.ok) {
    throw new Error(
      `sheet fetch HTTP ${res.status} — check the id and that the sheet is shared "Anyone with the link can view"`
    );
  }
  return parseSheetCsv(await res.text());
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/scanner.ts test/scanner.test.ts
git commit -m "feat(scanner): fetch symbols from a public Google Sheet CSV"
```

---

## Task 9: Qualify bare tickers — `qualifySymbols()`

**Files:**
- Modify: `src/scanner.ts`
- Test: `test/scanner.test.ts`

**Why:** the scanner drops bare tickers (verified). Resolve any symbol lacking `:` to `EXCHANGE:SYMBOL` via `searchSymbol`. Injectable resolver keeps it unit-testable without network.

- [ ] **Step 1: Write the failing test**

```typescript
// append to test/scanner.test.ts
import { qualifySymbols } from '../src/scanner';

test('qualifySymbols leaves already-qualified symbols untouched', async () => {
  const resolver = async () => { throw new Error('should not be called'); };
  assert.deepEqual(await qualifySymbols(['NASDAQ:AAPL', 'BINANCE:BTCUSDT'], resolver), [
    'NASDAQ:AAPL', 'BINANCE:BTCUSDT',
  ]);
});

test('qualifySymbols resolves bare tickers via the resolver', async () => {
  const resolver = async (q: string) =>
    q === 'AAPL' ? [{ tvSymbol: 'NASDAQ:AAPL' } as any] : [];
  assert.deepEqual(await qualifySymbols(['AAPL', 'NYSE:T'], resolver), ['NASDAQ:AAPL', 'NYSE:T']);
});

test('qualifySymbols drops bare tickers that cannot be resolved', async () => {
  const resolver = async () => [];
  assert.deepEqual(await qualifySymbols(['ZZZNOPE'], resolver), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `qualifySymbols` not exported.

- [ ] **Step 3: Write minimal implementation**

```typescript
// append to src/scanner.ts

type Resolver = (q: string) => Promise<SearchResult[]>;

/** Ensure every symbol is EXCHANGE:SYMBOL. Bare ones are resolved via `resolver`
 *  (defaults to searchSymbol); unresolvable bare symbols are dropped. */
export async function qualifySymbols(
  symbols: string[],
  resolver: Resolver = searchSymbol
): Promise<string[]> {
  const out: string[] = [];
  for (const s of symbols) {
    const sym = s.trim();
    if (sym.includes(':')) {
      out.push(sym.toUpperCase());
      continue;
    }
    const hits = await resolver(sym);
    if (hits[0]?.tvSymbol) out.push(hits[0].tvSymbol);
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/scanner.ts test/scanner.test.ts
git commit -m "feat(scanner): qualifySymbols() resolves bare tickers to EXCHANGE:SYMBOL"
```

---

## Task 10: `tv_watchlist_data` tool — read full symbols, enrich a list

**Files:**
- Modify: `src/driver.ts` (add a `full` option to `readCurrentSymbols`)
- Modify: `src/server.ts` (new tool + branch)

- [ ] **Step 1: Add a `full` option to `readCurrentSymbols`**

In `src/driver.ts`, change the signature and the snapshot reader so it can return exchange-qualified symbols. Replace the function header line:

```typescript
export async function readCurrentSymbols(page: Page): Promise<string[]> {
```

with:

```typescript
export async function readCurrentSymbols(page: Page, full = false): Promise<string[]> {
```

Then inside the `snapshot` closure, replace the `page.evaluate(() => { ... })` body's attribute logic to honor `full`. Change the `const symbols = await page.evaluate(() => {` call to pass `full` and prefer `data-symbol-full` when requested:

```typescript
    const symbols = await page.evaluate((wantFull) => {
      const out: string[] = [];
      if (wantFull) {
        document.querySelectorAll('[data-symbol-full]').forEach((el) => {
          const v = el.getAttribute('data-symbol-full');
          if (v) out.push(v);
        });
        if (out.length) return out;
      }
      document.querySelectorAll('[data-symbol-short]').forEach((el) => {
        const v = el.getAttribute('data-symbol-short');
        if (v) out.push(v);
      });
      if (out.length === 0) {
        document.querySelectorAll('[data-symbol-full]').forEach((el) => {
          const v = (el.getAttribute('data-symbol-full') || '').split(':').pop();
          if (v) out.push(v);
        });
      }
      return out;
    }, full);
```

(The existing `tv_read_watchlist` call site stays `readCurrentSymbols(page)` → defaults to `full=false`, unchanged behavior.)

- [ ] **Step 2: Add the import and helper in `src/server.ts`**

Extend the scanner import (from Task 6) to include the new functions:

```typescript
import { screener, quote, indicators, searchSymbol, qualifySymbols, fetchSheetSymbols, QUOTE_COLUMNS, buildIndicatorColumns, parseScanResponse, scan, inferMarket } from './scanner';
```

- [ ] **Step 3: Register the tool in `TOOLS`**

Add to the `TOOLS` array:

```typescript
  { name: 'tv_watchlist_data', description: 'Pull data for every symbol in a list, in one call. Source (exactly one): watchlist (TV list name, needs login), symbols (array), or sheet (Google Sheet id/URL, public CSV). Default = quote snapshot (price/change/RVOL/RSI/recommend); pass indicators+timeframes for a TA matrix. Bare tickers are auto-qualified.',
    inputSchema: { type: 'object', properties: {
      watchlist: { type: 'string' },
      symbols: { type: 'array', items: { type: 'string' } },
      sheet: { type: 'string' },
      indicators: { type: 'array', items: { type: 'string' } },
      timeframes: { type: 'array', items: { type: 'string' } },
      market: { type: 'string' } },
      additionalProperties: false } },
```

- [ ] **Step 4: Add the handler branch**

In `src/server.ts`, the `tv_watchlist_data` branch needs the browser **only** when reading a TV watchlist. Put it just after the other data-tool branches (from Task 6), still before `const page = await getPage()` — and call `getPage()` lazily inside, only for the watchlist source:

```typescript
    if (name === 'tv_watchlist_data') {
      // 1) Resolve the raw symbol list from exactly one source.
      let raw: string[] = [];
      if (Array.isArray(args.symbols) && args.symbols.length) {
        raw = (args.symbols as string[]).map(String);
      } else if (args.sheet) {
        raw = await fetchSheetSymbols(String(args.sheet));
      } else if (args.watchlist) {
        const page = await getPage();
        if (!(await ensureReady(page))) {
          return errText('Not logged into TradingView. Run `npm run login` once.');
        }
        const found = await openWatchlist(page, String(args.watchlist), false);
        if (!found) return errText(`watchlist not found: ${args.watchlist}`);
        raw = await readCurrentSymbols(page, true); // full = exchange-qualified
      } else {
        return errText('provide one of: symbols, sheet, or watchlist');
      }
      if (!raw.length) return errText('no symbols resolved from the given source');

      // 2) Qualify bare tickers (scanner drops unqualified ones).
      const tickers = await qualifySymbols(raw);
      if (!tickers.length) return errText('no symbols could be qualified to EXCHANGE:SYMBOL');

      // 3) One scan call for the whole list.
      const inds = Array.isArray(args.indicators) ? (args.indicators as string[]) : [];
      const tfs = Array.isArray(args.timeframes) ? (args.timeframes as string[]) : [];
      const columns = inds.length ? buildIndicatorColumns(inds, tfs.length ? tfs : ['1d']) : QUOTE_COLUMNS;
      const mkt = (args.market as string) || inferMarket(tickers[0]);
      const json = await scan(mkt, { symbols: { tickers }, columns });
      const rows = parseScanResponse(json, columns);
      return text(JSON.stringify({ count: rows.length, requested: raw.length, rows }));
    }
```

- [ ] **Step 5: Typecheck, test, and manual smoke checks**

Run: `npm run typecheck`
Expected: no errors.

Run: `npm test`
Expected: PASS.

Manual (direct array — no browser, no login):
```bash
npx tsx -e "import('./src/server.ts')" >/dev/null 2>&1 || true
npx tsx -e "import('./src/scanner.ts').then(async m => { const t = await m.qualifySymbols(['AAPL','NVDA']); console.log(await m.quote(t)); })"
```
Expected: qualified to `NASDAQ:AAPL`/`NASDAQ:NVDA`, returns rows with RVOL/RSI.

Manual (Google Sheet — set a real public sheet id):
```bash
npx tsx -e "import('./src/scanner.ts').then(async m => console.log((await m.fetchSheetSymbols('<SHEET_ID_OR_URL>')).slice(0,5)))"
```
Expected: first 5 symbols from column A.

- [ ] **Step 6: Commit**

```bash
git add src/driver.ts src/server.ts
git commit -m "feat(server): tv_watchlist_data — enrich watchlist/sheet/array via scanner"
```

---

## Out of scope (deferred / declined)

- **Parallel batch screenshots (browser pooling)** — inspired by `ertugrul59`. Performance-only; our single-page+mutex design is deliberate. Revisit if screenshot latency becomes a real bottleneck.
- **Alerts CRUD** — inspired by `tradesdontlie`. Fragile UI automation; defer until there's a concrete need to push from TV itself (the radar already pushes via Telegram).
- **Pine Script / TradingView Desktop via CDP** — inspired by `tradesdontlie`. Declined: requires the Desktop app + paid subscription and is heavy relative to value.
- **Telegram delivery** — not a tool in this server. The radar already owns Telegram delivery; "screener hit → Telegram alert" is orchestration wired at the radar level using the existing Telegram channel + `tv_screener`.

---

## Self-Review

- **Spec coverage:** P1 `tv_screener` (Task 4+6), P2 `tv_quote` (Task 3+6), P3 `tv_indicators` (Task 5+6), P4 `tv_search` (Task 5+6), wiring (Task 6), docs (Task 7), P1.5 `tv_watchlist_data` (Tasks 8–10: Sheet source, qualify, tool). All five prioritized tools covered.
- **Placeholder scan:** none — every column name and endpoint was verified live (incl. the bare-ticker drop and the Sheet CSV export pattern); all code blocks are complete.
- **Type consistency:** `ScanRow`, `parseScanResponse`, `resolveColumn`, `normalizeOp`, `scan`, `buildQuoteBody`/`QUOTE_COLUMNS`, `buildScreenerBody`/`ScreenerOptions`, `buildIndicatorColumns`, `parseSearchResults`/`SearchResult`, `fetchSheetSymbols`/`parseSheetCsv`/`sheetIdFromInput`, `qualifySymbols` are each defined once and reused with the same signatures across tasks. `tv_watchlist_data` composes `fetchSheetSymbols`/`qualifySymbols`/`scan`/`parseScanResponse`/`buildIndicatorColumns`/`QUOTE_COLUMNS`/`inferMarket` and `readCurrentSymbols(page, true)` exactly as defined. **Note:** Task 10 Step 2 supersedes Task 6 Step 1's import line — the engineer adds the extra named imports to the same statement.
