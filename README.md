# tradingview-mcp

A standalone MCP server for TradingView automation: chart screenshots, watchlist CRUD by name, and session status. Runs in-process via `tsx` (no compiled output needed).

## What it is

An MCP server exposing 5 tools that drive a persistent Chromium profile via Playwright to interact with TradingView — take chart screenshots, read/add/remove symbols in named watchlists, and check login state. Because it uses a persistent profile, you log in once interactively and all subsequent tool calls reuse that session.

## Setup

### 1. Install

```bash
cd /Users/kobihazout/tradingview-mcp
npm install
npx playwright install chromium
```

### 2. One-time login

```bash
npm run login
```

This opens a non-headless Chromium window pointed at TradingView's sign-in page. Log in with your TradingView credentials, then close the browser window. The session is saved in the persistent profile and reused for all future tool calls.

> If you already have a logged-in Playwright profile (e.g. the radar project's profile at `~/.cache/svr-tv-sync/chromium-profile`), set `TV_PROFILE_DIR` to point at it and skip the login step.

## Tools

| Tool | Description |
|------|-------------|
| `tv_screenshot` | Screenshot a symbol's TradingView chart. Required: `symbol`. Optional: `interval` (single) or `intervals` (array, max 4). Returns base64 PNG image(s). |
| `tv_read_watchlist` | Read the symbols in a named TradingView watchlist. Required: `watchlist`. |
| `tv_add_symbols` | Add symbols to a named watchlist (creates the list if it doesn't exist). Required: `watchlist`, `symbols` (array). |
| `tv_remove_symbols` | Remove symbols from a named watchlist. Required: `watchlist`, `symbols` (array). |
| `tv_session_status` | Report whether the saved profile is currently logged in. Returns `{ loggedIn, profileDir }`. |

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TV_PROFILE_DIR` | `~/.cache/tradingview-mcp/profile` | Path to the persistent Chromium profile directory. Point this at an existing logged-in profile to skip `npm run login`. |
| `TV_HEADED` | unset (headless) | Set to any value to run Chromium with a visible window (useful for debugging). |

## Register with Claude Code

```bash
claude mcp add tradingview --scope user -- npx tsx /Users/kobihazout/tradingview-mcp/src/server.ts
```

After registering, reload Claude Code (or start a new session). The 5 `tv_*` tools will be available.

## Development

```bash
# Type-check
npm run typecheck

# Run unit tests (no browser required)
npm test

# Run the server directly (stdio MCP protocol)
npm start
```
