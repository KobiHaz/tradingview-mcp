#!/usr/bin/env -S npx tsx
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { getPage, PROFILE_DIR } from './browser';
import {
  isLoggedIn, openWatchlist, readCurrentSymbols, addSymbolsBulk, removeSymbol, captureChart, tvInterval,
} from './driver';

// tvInterval is imported for use in the server if needed — suppress unused-import lint
void tvInterval;

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
];

function text(t: string) { return { content: [{ type: 'text', text: t }] }; }
function errText(t: string) { return { isError: true, content: [{ type: 'text', text: t }] }; }

async function ensureLoggedIn(page: import('playwright').Page): Promise<boolean> {
  await page.goto('https://www.tradingview.com/chart/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(5000);
  return isLoggedIn(page);
}

const server = new Server({ name: 'tradingview', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args: Record<string, unknown> = (req.params.arguments as Record<string, unknown>) || {};
  try {
    const page = await getPage();

    if (name === 'tv_session_status') {
      const loggedIn = await ensureLoggedIn(page);
      return text(JSON.stringify({ loggedIn, profileDir: PROFILE_DIR }));
    }

    if (!(await ensureLoggedIn(page))) {
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
      const syms = (args.symbols as string[]).map((s) => String(s).trim().toUpperCase()).filter(Boolean);
      if (!syms.length) return errText('symbols must be a non-empty array');
      await openWatchlist(page, String(args.watchlist), true);
      const { added, failed } = await addSymbolsBulk(page, syms);
      return { isError: added.length === 0 && failed.length > 0, content: [{ type: 'text', text: JSON.stringify({ watchlist: args.watchlist, added, failed }) }] };
    }

    if (name === 'tv_remove_symbols') {
      const syms = (args.symbols as string[]).map((s) => String(s).trim().toUpperCase()).filter(Boolean);
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
});

(async () => {
  const transport = new StdioServerTransport();
  await server.connect(transport);
})().catch((e) => {
  process.stderr.write(`tradingview-mcp failed to start: ${(e as Error).message}\n`);
  process.exit(1);
});
