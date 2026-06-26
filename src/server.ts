#!/usr/bin/env -S npx tsx
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Page } from 'playwright';
import { getPage, PROFILE_DIR } from './browser';
import {
  isLoggedIn, openWatchlist, readCurrentSymbols, addSymbolsBulk, removeSymbol, captureChart,
} from './driver';
import { screener, qualifySymbols, fetchSheetSymbols, QUOTE_COLUMNS, buildIndicatorColumns, parseScanResponse, scan, inferMarket } from './scanner';

// Serialize tool calls — they all drive one shared browser page.
let lock: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = lock.then(fn, fn);
  lock = run.then(() => {}, () => {});
  return run;
}

const SYMBOLS_SCHEMA = { type: 'array', items: { type: 'string' }, minItems: 1 };

const TOOLS = [
  { name: 'tv_screenshot', description: 'Screenshot a symbol\'s TradingView chart (saved layout). Optional interval / intervals (max 4).',
    inputSchema: { type: 'object', properties: {
      symbol: { type: 'string' }, interval: { type: 'string' },
      intervals: { type: 'array', items: { type: 'string' }, maxItems: 4 } },
      required: ['symbol'], additionalProperties: false } },
  { name: 'tv_read_watchlist', description: 'Read the symbols in a named TradingView watchlist.',
    inputSchema: { type: 'object', properties: { watchlist: { type: 'string' } }, required: ['watchlist'], additionalProperties: false } },
  { name: 'tv_add_symbols', description: 'Add symbols to a named watchlist (creates it if missing).',
    inputSchema: { type: 'object', properties: { watchlist: { type: 'string' }, symbols: SYMBOLS_SCHEMA }, required: ['watchlist', 'symbols'], additionalProperties: false } },
  { name: 'tv_remove_symbols', description: 'Remove symbols from a named watchlist.',
    inputSchema: { type: 'object', properties: { watchlist: { type: 'string' }, symbols: SYMBOLS_SCHEMA }, required: ['watchlist', 'symbols'], additionalProperties: false } },
  { name: 'tv_session_status', description: 'Report whether the saved TradingView profile is logged in.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'tv_screener', description: 'Scan the market for symbols matching technical filters (no login needed). Fields: rvol, rsi, volume, close, change, macd, sma20/50/200, recommend. Ops: gt, lt, gte, lte, eq, between. Returns ranked rows.',
    inputSchema: { type: 'object', properties: {
      filters: { type: 'array', items: { type: 'object', properties: {
        field: { type: 'string' }, op: { type: 'string' },
        value: {} }, required: ['field', 'op', 'value'], additionalProperties: false } },
      market: { type: 'string', description: 'america (default) or crypto' },
      sort: { type: 'object', properties: { field: { type: 'string' }, order: { type: 'string', enum: ['asc', 'desc'] } }, additionalProperties: false },
      limit: { type: 'number' } },
      required: ['filters'], additionalProperties: false } },
  { name: 'tv_watchlist_data', description: 'Pull data for every symbol in a list, in one call. Source (exactly one): watchlist (TV list name, needs login), symbols (array), or sheet (Google Sheet id/URL, public CSV). Default = quote snapshot (price/change/RVOL/RSI/recommend); pass indicators+timeframes for a TA matrix. Bare tickers are auto-qualified. Use `tab` to target a specific tab of a multi-tab sheet.',
    inputSchema: { type: 'object', properties: {
      watchlist: { type: 'string' },
      symbols: { type: 'array', items: { type: 'string' }, minItems: 1 },
      sheet: { type: 'string' },
      tab: { type: 'string', description: 'Optional sheet tab name (used with `sheet`).' },
      indicators: { type: 'array', items: { type: 'string' } },
      timeframes: { type: 'array', items: { type: 'string' } },
      market: { type: 'string' } },
      additionalProperties: false } },
];

function text(t: string) { return { content: [{ type: 'text', text: t }] }; }
function errText(t: string) { return { isError: true, content: [{ type: 'text', text: t }] }; }

let readyPage: Page | null = null;
let loggedInCache = false;
// Navigate to the chart + verify login once per page; cached on repeat calls.
async function ensureReady(page: Page): Promise<boolean> {
  if (readyPage === page) return loggedInCache;
  await page.goto('https://www.tradingview.com/chart/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(5000);
  loggedInCache = await isLoggedIn(page);
  readyPage = page;
  return loggedInCache;
}

const server = new Server({ name: 'tradingview', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) =>
  withLock(async () => {
  const name = req.params.name;
  const args: Record<string, unknown> = (req.params.arguments as Record<string, unknown>) || {};
  try {
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
    if (name === 'tv_watchlist_data') {
      // 1) Resolve the raw symbol list from exactly one source.
      let raw: string[] = [];
      if (Array.isArray(args.symbols) && args.symbols.length) {
        raw = (args.symbols as string[]).map(String);
      } else if (args.sheet) {
        raw = await fetchSheetSymbols(String(args.sheet), args.tab ? String(args.tab) : undefined);
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

    const page = await getPage();

    if (name === 'tv_session_status') {
      readyPage = null;                 // force a fresh nav + check
      const loggedIn = await ensureReady(page);
      return text(JSON.stringify({ loggedIn, profileDir: PROFILE_DIR }));
    }

    if (!(await ensureReady(page))) {
      return errText('Not logged into TradingView. Run `npm run login` in the tradingview-mcp repo once.');
    }

    if (name === 'tv_screenshot') {
      const symbol = String(args.symbol || '').trim();
      if (!symbol) return errText('symbol is required');
      const intervals: (string | null)[] = Array.isArray(args.intervals) && (args.intervals as string[]).length
        ? (args.intervals as string[]).slice(0, 4)
        : [args.interval ? String(args.interval) : null];
      const content: Array<{ type: string; data?: string; mimeType?: string; text?: string }> = [];
      for (const iv of intervals) {
        const out = path.join(os.tmpdir(), `tv-shot-${symbol.replace(/[^a-zA-Z0-9]/g, '_')}-${iv ? iv.replace(/[^a-zA-Z0-9]/g, '') : 'def'}-${Date.now()}.png`);
        try {
          await captureChart(page, symbol, iv, out);
          const data = fs.readFileSync(out).toString('base64');
          fs.unlink(out, () => {});
          content.push({ type: 'image', data, mimeType: 'image/png' });
          content.push({ type: 'text', text: `TradingView ${symbol} @ ${iv || 'default'}` });
        } catch (e) {
          content.push({ type: 'text', text: `[warning] screenshot failed for ${symbol} @ ${iv || 'default'}: ${(e as Error).message}` });
        }
      }
      if (!content.some((c) => c.type === 'image')) return errText('no readable screenshots produced');
      return { content };
    }

    if (name === 'tv_read_watchlist') {
      const found = await openWatchlist(page, String(args.watchlist), false);
      if (!found) return errText(`watchlist not found: ${args.watchlist}`);
      const symbols = await readCurrentSymbols(page);
      return text(JSON.stringify({ watchlist: args.watchlist, symbols }));
    }

    if (name === 'tv_add_symbols') {
      const syms = (Array.isArray(args.symbols) ? args.symbols : [])
        .map((s) => String(s).trim().toUpperCase()).filter(Boolean);
      if (!syms.length) return errText('symbols must be a non-empty array');
      await openWatchlist(page, String(args.watchlist), true);
      const { added, failed } = await addSymbolsBulk(page, syms);
      return { isError: added.length === 0 && failed.length > 0, content: [{ type: 'text', text: JSON.stringify({ watchlist: args.watchlist, added, failed }) }] };
    }

    if (name === 'tv_remove_symbols') {
      const syms = (Array.isArray(args.symbols) ? args.symbols : [])
        .map((s) => String(s).trim().toUpperCase()).filter(Boolean);
      if (!syms.length) return errText('symbols must be a non-empty array');
      const found = await openWatchlist(page, String(args.watchlist), false);
      if (!found) return errText(`watchlist not found: ${args.watchlist}`);
      const removed: string[] = [], notFound: string[] = [];
      for (const s of syms) (await removeSymbol(page, s)) ? removed.push(s) : notFound.push(s);
      return { isError: removed.length === 0 && notFound.length > 0, content: [{ type: 'text', text: JSON.stringify({ watchlist: args.watchlist, removed, notFound }) }] };
    }

    return errText(`Unknown tool: ${name}`);
  } catch (e) {
    return errText(`${name} failed: ${(e as Error).message}`);
  }
  })
);

(async () => {
  const transport = new StdioServerTransport();
  await server.connect(transport);
})().catch((e) => {
  process.stderr.write(`tradingview-mcp failed to start: ${(e as Error).message}\n`);
  process.exit(1);
});
