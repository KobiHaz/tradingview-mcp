# Watchlist → Google Sheet Sync — Design

**Date:** 2026-06-24
**Status:** Approved (design)

## Problem

A friend maintains several sector watchlists in TradingView. We want those lists
mirrored into a Google Sheet (one tab per sector) so the Sheet becomes a durable,
account-independent source of truth that the existing `tv_watchlist_data` tool can
read for analysis. There is no native TradingView → Sheets export, and TradingView
has no account-to-account watchlist sync, so we build a one-directional mirror:
**TradingView (his shared lists) → Google Sheet tabs.**

## Decisions (locked)

| Decision | Choice |
|----------|--------|
| Source of truth ownership | Friend keeps editing in TradingView; we auto-mirror |
| How his lists are exposed | Public **"Share list"** links (one per sector), stay live |
| Tab structure | One symbol column per tab, **fully rewritten** each run (no inline notes) |
| Trigger | Scheduled automatically (local `launchd`), ~15:30 Israel time, configurable |
| Sheet layout | **One** spreadsheet `watchlist-sync`, one tab per sector |
| Read side | Extend existing reader to accept a `tab` parameter |

### Verified facts (TradingView sharing)

- "Share list" mode produces a public link; the shared list **stays live** and
  reflects the owner's edits as long as sharing remains on.
- "Copy the list to myself" creates a **static** copy — we must NOT use this; we
  read the live shared page.
- Sharing is "anyone with the link" (unlisted but public). Friend must accept this.
- Source: https://www.tradingview.com/support/solutions/43000665060-how-can-i-share-my-watchlist/

## Architecture

```
launchd (daily, configurable time)
  → npm run sync
     → for each source { name, shareUrl, tab }:
          driver.readSharedWatchlist(shareUrl)        # Playwright scrape (reuse scroll-read)
          sheetsWriter.writeTab(sheetId, tab, symbols) # googleapis service account
     → Sheet updated, summary logged
  ↓ downstream (unchanged data flow)
tv_watchlist_data { sheet, tab }                       # existing analysis pipeline
```

The mirror depends on the **local logged-in Chromium profile**, so it must run on
the user's machine, not in the cloud.

## Components (units, with boundaries)

### `src/sources.ts`
- **Does:** loads and validates the source mapping from `watchlist-sources.json`.
- **Interface:** `loadSources(): Source[]` where `Source = { name: string; shareUrl: string; tab: string }`.
- **Depends on:** fs only. Throws a clear error on missing/malformed config.
- `watchlist-sources.json` is **gitignored** (contains the friend's private links).
  A `watchlist-sources.example.json` is committed as a template.

### `src/driver.ts` (extend existing)
- **Add:** `readSharedWatchlist(page, shareUrl): Promise<string[]>`.
- **How:** navigate to `shareUrl`, dismiss popups (reuse `dismissPopups`), then reuse
  the existing scroll-and-collect logic. Existing `readCurrentSymbols` reads
  `[data-symbol-short]`; verify the shared page exposes the same attribute and, if
  not, add a shared-page selector fallback. No change to existing functions' behavior.

### `src/sheets-writer.ts`
- **Does:** writes a symbol list into one tab of the target spreadsheet.
- **Interface:** `writeTab(sheetId, tab, symbols): Promise<void>` — ensures the tab
  exists (create if missing), clears column A, writes a `Symbol` header + symbols.
- **Depends on:** `googleapis` (new dep) authed via a **service account** JSON whose
  path comes from env `GOOGLE_SHEETS_CREDENTIALS`. The spreadsheet is shared with the
  service-account email as **Editor**, and also kept "anyone with link can view" so
  the existing CSV read path keeps working.

### `src/sync.ts`
- **Does:** orchestrates one full sync run; CLI entry for `npm run sync`.
- **Flow:** load sources → for each, read shared list then write tab → print a
  per-list summary (read count, added/removed vs. the tab's previous contents).
- **Depends on:** `sources`, `driver` (+ a Playwright context like the other entries),
  `sheets-writer`. Continues past per-list failures; exits non-zero if any failed.

### `src/scanner.ts` (extend existing read side)
- **Add `tab` support to `fetchSheetSymbols`:** when a `tab` is given, read via the
  gviz CSV endpoint
  `https://docs.google.com/spreadsheets/d/{id}/gviz/tq?tqx=out:csv&sheet={tab}`
  (selects a tab by name); otherwise keep the current first-tab `export?format=csv`.
- **Thread `tab` through** `tv_watchlist_data` in `src/server.ts` (new optional
  `tab` arg in the schema). Existing callers unaffected.

### Scheduling
- A `launchd` plist template + a short `scripts/install-schedule.sh` (or documented
  manual step) that runs `npm run sync` daily at the configured time, logging to a
  file under `.cache/`.

## Data flow & formats

- A shared list yields qualified symbols (`EXCHANGE:SYMBOL`); store them as-is.
  `tv_watchlist_data` already qualifies bare tickers, so qualified input is safe.
- Tab format: row 1 = `Symbol` header, rows 2+ = one symbol each in column A. This
  matches `parseSheetCsv`, which drops a `symbol` header and reads column A.

## Error handling (critical)

- **Broken link / sharing turned off:** log the error for that list, continue with
  the others, and **do not touch** that tab.
- **Read returns 0 symbols:** treated as a suspected scrape failure → **skip the
  write** so a transient miss never wipes a good tab. Logged loudly.
- **Sheets auth failure:** hard fail with an actionable message (which env var /
  which email to share the sheet with).
- **Partial scroll read:** the existing reader already returns a partial set with a
  warning rather than throwing; sync logs the warning but still writes (a partial
  list is non-empty, so the empty-guard does not trip — acceptable, surfaced in logs).

## Testing

Unit tests in `test/` matching the existing `tsx --test` style:
- `sources`: parse valid config; clear errors on missing file / bad shape.
- `scanner`: `tab` → correct gviz URL; no-tab → unchanged `export` URL; CSV parsing
  unchanged.
- `sheets-writer`: with a mocked googleapis client, assert the request payload
  (tab-create when missing, clear range, written values incl. header).
- `sync`: empty-read guard skips the write; one list failing does not abort the rest.

The live Playwright scrape and real Sheets I/O are integration concerns kept thin and
out of unit tests (googleapis client is mocked).

## Out of scope (YAGNI)

- Bi-directional sync (Sheet → TradingView).
- Inline annotation columns / symbol-keyed merge (decided against).
- Cloud execution (depends on the local browser profile).
- Auto-discovering the friend's lists (links are provided explicitly in config).

## One-time setup the user must do

1. Friend: enable "Share list" per sector, send the public links.
2. Create the `watchlist-sync` Google Sheet; set "anyone with link can view".
3. GCP: enable Sheets API, create a service account, download its JSON key, share the
   sheet with the service-account email as Editor.
4. Fill `watchlist-sources.json` (name, shareUrl, tab per sector) and set
   `GOOGLE_SHEETS_CREDENTIALS` to the JSON key path.
5. Install the schedule.
