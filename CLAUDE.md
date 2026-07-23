# CLAUDE.md — tradingview-mcp

## Purpose

A standalone MCP server for TradingView automation. Exposes tools to take chart
screenshots, do watchlist CRUD by name, run market-wide technical screeners, and
check login state. Runs in-process via `tsx` (no build step).

## Stack

- Node.js + TypeScript (CommonJS, run directly with `tsx` — no compiled output)
- `@modelcontextprotocol/sdk` — MCP server framework
- `playwright` — drives a persistent Chromium profile for logged-in TradingView actions
- Data tools also hit TradingView's public endpoints directly (no login needed)

## Structure

- `src/server.ts` — MCP entry point; registers and dispatches the tools (also the `bin`)
- `src/driver.ts` — TradingView interaction logic (screenshots, watchlist ops)
- `src/browser.ts` — persistent Chromium profile / Playwright setup
- `src/scanner.ts` — screener + watchlist-data logic against public endpoints
- `src/login.ts` — one-time interactive login flow (`npm run login`)
- `test/` — unit tests (`driver.test.ts`, `scanner.test.ts`), no browser required
- `docs/` — additional docs

## Run / dev

```bash
npm install
npx playwright install chromium
npm run login       # one-time interactive TradingView sign-in
npm start           # run the server over stdio MCP protocol
npm test            # unit tests (no browser)
npm run typecheck   # tsc --noEmit
```

Register with Claude Code:
```bash
claude mcp add tradingview --scope user -- npx tsx /Users/kobihazout/dev/tradingview-mcp/src/server.ts
```

## Conventions / notes

- Login-based tools reuse a persistent Chromium profile — log in once, sessions persist.
- Login-required tools: `tv_screenshot`, `tv_read_watchlist`, `tv_add_symbols`,
  `tv_remove_symbols`, `tv_session_status`.
- Data tools (no login): `tv_screener`, `tv_watchlist_data` — hit public endpoints.
- One `tv_screener` / `tv_watchlist_data` call scans a single market (inferred from
  the first symbol, or set via `market`); mixed-market lists must be split per call.
- Env vars: `TV_PROFILE_DIR` (persistent profile path; point at an existing logged-in
  profile to skip login), `TV_HEADED` (set to run Chromium with a visible window).
- The `.claude/skills/` reference files are a generic cabinet-wide Repomix dump, not
  repo-specific — do not rely on them for this project's structure.
