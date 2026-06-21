# tradingview-mcp — Phase 1 Design (standalone generic TradingView MCP)

**Date:** 2026-06-20
**Status:** Approved for planning (Kobi: "Phase 1 now, to the end").
**Origin:** Extracted from the radar project's `mcp-tv-sync` so TradingView
automation (screenshots, watchlist CRUD, session check) is reusable across
projects, not bound to Smart Volume Radar.

## Goal

A standalone MCP server, in its own repo, exposing **generic** TradingView
browser-automation tools that any project can use:
`tv_screenshot`, `tv_read_watchlist`, `tv_add_symbols`, `tv_remove_symbols`,
`tv_session_status`. No radar logic; watchlists addressed by arbitrary name.

## Scope (Phase 1)

In scope:
1. New repo `~/tradingview-mcp/` (TypeScript, Playwright, `@modelcontextprotocol/sdk`).
2. A `driver` module: the generic Playwright primitives, copied + de-radar-ified
   from the radar `sync-tv-watchlist.ts` (the fragile selectors live here only).
3. An in-process MCP server (drives Playwright directly — no subprocess) with the
   5 generic tools + a reused, lazily-launched browser session.
4. A `login` CLI for one-time interactive auth.
5. Unit tests for the pure helpers; a live acceptance run against the radar's
   existing logged-in profile.

Out of scope (Phase 2, separate effort): refactoring the **radar** repo to import
this driver and delete its duplicated copy. Until then the primitives exist in
both places (the radar nightly stays untouched — zero risk). Also out: the
radar-specific `tv_sync` (4-list rotation/prune) and `tv_deep_dive` (radar data) —
those stay in the radar repo.

## Architecture

In-process (not the radar's shell-out): the radar primitives are already clean
`page`-taking functions, so the MCP imports them and calls Playwright directly —
no JSON-over-stdout marshalling, and the browser session is reused across calls.

```
tradingview-mcp/
  package.json            # type:module or commonjs; deps: @modelcontextprotocol/sdk, playwright; tsx for run
  tsconfig.json
  src/
    driver.ts             # SELECTORS + generic primitives (no radar)
    browser.ts            # lazy persistent-context launch, reuse, close-on-exit, default timeouts
    server.ts             # MCP server: tool defs + handlers calling the driver
    login.ts              # one-time interactive login CLI (headed)
  test/
    driver.test.ts        # unit tests for tvInterval + pure helpers
  README.md
```

### `src/driver.ts` (extracted/cleaned from the radar script)
Generic, watchlist-by-name, no `DEFAULT_TARGETS`/radar coupling:
- `SELECTORS` (the `TV_SELECTORS` set)
- `dismissPopups(page)`
- `isLoggedIn(page): Promise<boolean>`
- `openWatchlist(page, name, createIfMissing): Promise<boolean>`
- `readCurrentSymbols(page): Promise<string[]>` (with the 30s scroll deadline)
- `addSymbolsBulk(page, symbols): Promise<{added, failed}>`
- `removeSymbol(page, symbol): Promise<boolean>`
- `tvInterval(raw): string` (friendly→TV code map; `1M` left unmapped)
- `chartClip(page): Promise<BoundingBox|null>` (chart-area selector chain)
- `captureChart(page, symbol, interval, outPath): Promise<void>` (goto `/chart/?symbol=&interval=`, render wait, chart-only screenshot)

### `src/browser.ts`
- `getPage()`: lazily `chromium.launchPersistentContext(PROFILE_DIR, {headless, …})`
  on first use, cache the context+page, reuse on later calls; sets
  `page.setDefaultTimeout(20s)` / `setDefaultNavigationTimeout(45s)`.
- `closeBrowser()` on `process.on('exit'/'SIGINT'/'SIGTERM')`.
- `PROFILE_DIR = process.env.TV_PROFILE_DIR || ~/.cache/tradingview-mcp/profile`.
- `HEADLESS = process.env.TV_HEADED ? false : true`.

### `src/server.ts` (MCP, stdio)
Tools (watchlist = any string name):
| Tool | Params | Returns |
|------|--------|---------|
| `tv_screenshot` | symbol (req), interval?, intervals? (max 4) | image(s) + caption |
| `tv_read_watchlist` | watchlist (req) | { symbols[] } |
| `tv_add_symbols` | watchlist (req), symbols[] (req) | { added[], failed[] } |
| `tv_remove_symbols` | watchlist (req), symbols[] (req) | { removed[], notFound[] } |
| `tv_session_status` | — | { loggedIn, profileDir } |

Each handler: `const page = await getPage();` then call the driver; screenshots
return MCP `image` content (read PNG → base64 → unlink), others return JSON text.
A not-logged-in state on a watchlist/screenshot call returns a clear error telling
the caller to run `npm run login`.

### `src/login.ts`
`chromium.launchPersistentContext(PROFILE_DIR, {headless:false})`, navigate to
`tradingview.com/#signin`, wait for the window to close (or 10-min cap), persist
the session. Mirrors the radar `--login` flow.

## Profile / auth
Own profile by default (`~/.cache/tradingview-mcp/profile`) — one-time
`npm run login`. For development/verification, set
`TV_PROFILE_DIR=~/.cache/svr-tv-sync/chromium-profile` to reuse the radar's
already-logged-in session (same TV account) and skip the interactive login.

## Error handling
- Not logged in → tools return a clear "run `npm run login`" error (not a crash).
- Screenshot: per-shot try/catch, isError only if zero readable images (mirrors
  the radar MCP); temp PNGs unlinked after read.
- add/remove: total failure surfaces as isError; partial reported in the payload.
- Browser launch failure → clear error; lazy launch means startup never blocks.

## Testing
- **Unit (`driver.test.ts`):** `tvInterval` maps `1D/D→D`, `1W/W→W`, `M→M`,
  `1H/60→60`, `4H/240→240`, pass-through unknown, `1M` unmapped; any pure
  symbol/argument normalization helper.
- **Live acceptance (manual, against the radar profile):**
  - `tv_session_status` → `{loggedIn:true}`.
  - `tv_screenshot({symbol:"NVDA"})` → a readable NVDA chart image.
  - `tv_read_watchlist({watchlist:"Lean Radar - Near"})` → its symbols.
  - add/remove round-trip of a throwaway ticker on a test list, restoring state.

## Registration
`claude mcp add tradingview --scope user -- npx tsx <repo>/src/server.ts` (or a
built JS entry). README documents `TV_PROFILE_DIR` and the one-time `npm run login`.
