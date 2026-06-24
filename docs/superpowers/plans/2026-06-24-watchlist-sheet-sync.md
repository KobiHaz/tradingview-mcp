# Watchlist → Google Sheet Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mirror a friend's TradingView sector watchlists (shared public links) into one Google Sheet, one tab per sector, on a daily schedule, so `tv_watchlist_data` can read them for analysis.

**Architecture:** A scheduled local CLI (`npm run sync`) reads each shared watchlist via the existing Playwright profile and writes its symbols into a named tab of one spreadsheet using the Google Sheets API (service account). The read side of `tv_watchlist_data` is extended to read a specific tab by name. Pure logic (config parsing, URL building, payload shaping, orchestration) is unit-tested; browser scraping and live Sheets I/O are kept thin.

**Tech Stack:** TypeScript (CommonJS, `tsx`), Playwright (existing persistent profile), `googleapis` (new), `node:test`.

---

## File Structure

- `src/sources.ts` (new) — load/validate `watchlist-sources.json` → `Source[]`.
- `src/sheets-writer.ts` (new) — `writeTab()` via googleapis + pure payload helpers.
- `src/sync.ts` (new) — `runSync()` orchestrator + CLI entry.
- `src/scanner.ts` (modify) — add `sheetCsvUrl(id, tab?)`; `fetchSheetSymbols(input, tab?)`.
- `src/server.ts` (modify) — add optional `tab` to `tv_watchlist_data`.
- `src/driver.ts` (modify) — add `readSharedWatchlist(page, url)`.
- `watchlist-sources.example.json` (new) — committed template.
- `.gitignore` (modify) — ignore `watchlist-sources.json` and `*.gserviceaccount.json`.
- `scripts/com.tradingview-mcp.sync.plist` (new) + `scripts/install-schedule.sh` (new).
- `test/sources.test.ts`, `test/sync.test.ts` (new); `test/scanner.test.ts`, `test/sheets-writer.test.ts` (new) (modify scanner test).
- `package.json` (modify) — `sync` script + `googleapis` dep.
- `README.md` (modify) — document the sync.

---

### Task 1: Source config loader (`src/sources.ts`)

**Files:**
- Create: `src/sources.ts`
- Create: `watchlist-sources.example.json`
- Test: `test/sources.test.ts`
- Modify: `.gitignore`

- [ ] **Step 1: Write the failing test**

Create `test/sources.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSources } from '../src/sources';

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

test('loadSources throws a clear error when file is missing', async () => {
  const { loadSources } = await import('../src/sources');
  assert.throws(() => loadSources(join(mkdtempSync(join(tmpdir(), 's-')), 'nope.json')),
    /watchlist-sources/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot find module `../src/sources`.

- [ ] **Step 3: Write minimal implementation**

Create `src/sources.ts`:

```typescript
import { readFileSync } from 'node:fs';

export interface Source {
  name: string;
  shareUrl: string;
  tab: string;
}

export function parseSources(json: string): Source[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error('watchlist-sources: file is not valid JSON');
  }
  if (!Array.isArray(data)) throw new Error('watchlist-sources: must be a JSON array');
  const seen = new Set<string>();
  return data.map((row, i) => {
    const r = row as Record<string, unknown>;
    for (const key of ['name', 'shareUrl', 'tab'] as const) {
      if (typeof r[key] !== 'string' || !(r[key] as string).trim()) {
        throw new Error(`watchlist-sources[${i}]: "${key}" must be a non-empty string`);
      }
    }
    const tab = (r.tab as string).trim();
    if (seen.has(tab)) throw new Error(`watchlist-sources: duplicate tab "${tab}"`);
    seen.add(tab);
    return { name: (r.name as string).trim(), shareUrl: (r.shareUrl as string).trim(), tab };
  });
}

export function loadSources(path = 'watchlist-sources.json'): Source[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(
      `watchlist-sources: cannot read "${path}". Copy watchlist-sources.example.json and fill it in.`
    );
  }
  return parseSources(raw);
}
```

- [ ] **Step 4: Create the example template + gitignore**

Create `watchlist-sources.example.json`:

```json
[
  { "name": "Semiconductors", "shareUrl": "https://www.tradingview.com/watchlists/REPLACE_ME/", "tab": "Semis" },
  { "name": "Energy", "shareUrl": "https://www.tradingview.com/watchlists/REPLACE_ME/", "tab": "Energy" }
]
```

Append to `.gitignore`:

```
watchlist-sources.json
*.gserviceaccount.json
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS for all `sources` tests.

- [ ] **Step 6: Commit**

```bash
git add src/sources.ts test/sources.test.ts watchlist-sources.example.json .gitignore
git commit -m "feat(sync): watchlist-sources config loader"
```

---

### Task 2: Tab-aware sheet read (`src/scanner.ts`)

**Files:**
- Modify: `src/scanner.ts:260-286`
- Test: `test/scanner.test.ts:1-11` (imports) + new tests

- [ ] **Step 1: Write the failing test**

Add to `test/scanner.test.ts` (and add `sheetCsvUrl` to the import block on lines 3-11):

```typescript
import { sheetCsvUrl } from '../src/scanner';

test('sheetCsvUrl without tab uses the first-sheet export endpoint', () => {
  assert.equal(
    sheetCsvUrl('ABC123'),
    'https://docs.google.com/spreadsheets/d/ABC123/export?format=csv'
  );
});

test('sheetCsvUrl with tab uses the gviz endpoint with the encoded sheet name', () => {
  assert.equal(
    sheetCsvUrl('ABC123', 'Big Tech'),
    'https://docs.google.com/spreadsheets/d/ABC123/gviz/tq?tqx=out:csv&sheet=Big%20Tech'
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `sheetCsvUrl` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/scanner.ts`, replace the `SHEET_CSV_URL` constant and `fetchSheetSymbols` (lines ~260, ~276-286) with:

```typescript
/** Build the public CSV URL for a sheet; with `tab`, target that tab by name via gviz. */
export function sheetCsvUrl(id: string, tab?: string): string {
  if (tab && tab.trim()) {
    return `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}`;
  }
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv`;
}

/** Fetch a public Google Sheet's first column as a symbol list (optionally a named tab). */
export async function fetchSheetSymbols(input: string, tab?: string): Promise<string[]> {
  const id = sheetIdFromInput(input);
  const res = await fetch(sheetCsvUrl(id, tab));
  if (!res.ok) {
    throw new Error(
      `sheet fetch HTTP ${res.status} — check the id/tab and that the sheet is shared "Anyone with the link can view"`
    );
  }
  return parseSheetCsv(await res.text());
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, including existing scanner tests.

- [ ] **Step 5: Commit**

```bash
git add src/scanner.ts test/scanner.test.ts
git commit -m "feat(sync): read a specific sheet tab by name (gviz)"
```

---

### Task 3: Thread `tab` through `tv_watchlist_data` (`src/server.ts`)

**Files:**
- Modify: `src/server.ts:48-56` (schema), `src/server.ts:97-98` (handler)

- [ ] **Step 1: Add the schema field**

In `src/server.ts`, in the `tv_watchlist_data` `inputSchema.properties` (after `sheet: { type: 'string' },` on line 52), add:

```typescript
      tab: { type: 'string', description: 'Optional sheet tab name (used with `sheet`).' },
```

Also update that tool's `description` string (line 48) to end with: ` Use \`tab\` to target a specific tab of a multi-tab sheet.`

- [ ] **Step 2: Use it in the handler**

In `src/server.ts`, change the sheet branch (line 97-98) from:

```typescript
      } else if (args.sheet) {
        raw = await fetchSheetSymbols(String(args.sheet));
```

to:

```typescript
      } else if (args.sheet) {
        raw = await fetchSheetSymbols(String(args.sheet), args.tab ? String(args.tab) : undefined);
```

- [ ] **Step 3: Verify it compiles**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/server.ts
git commit -m "feat(sync): tv_watchlist_data accepts an optional sheet tab"
```

---

### Task 4: Sheets writer (`src/sheets-writer.ts`)

**Files:**
- Create: `src/sheets-writer.ts`
- Test: `test/sheets-writer.test.ts`
- Modify: `package.json` (add `googleapis`)

- [ ] **Step 1: Add the dependency**

Run: `npm install googleapis@^144.0.0`
Expected: `googleapis` added to `dependencies`.

- [ ] **Step 2: Write the failing test (pure helpers)**

Create `test/sheets-writer.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tabExists, valuesPayload } from '../src/sheets-writer';

test('tabExists finds a tab by title', () => {
  const meta = { sheets: [{ properties: { title: 'Semis' } }, { properties: { title: 'Energy' } }] };
  assert.equal(tabExists(meta, 'Energy'), true);
  assert.equal(tabExists(meta, 'Missing'), false);
});

test('tabExists handles empty/missing metadata', () => {
  assert.equal(tabExists({}, 'X'), false);
});

test('valuesPayload writes a header then one symbol per row', () => {
  const out = valuesPayload('Semis', ['NASDAQ:NVDA', 'NASDAQ:AMD']);
  assert.equal(out.range, "'Semis'!A1");
  assert.deepEqual(out.values, [['Symbol'], ['NASDAQ:NVDA'], ['NASDAQ:AMD']]);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot find module `../src/sheets-writer`.

- [ ] **Step 4: Write the implementation**

Create `src/sheets-writer.ts`:

```typescript
import { google, sheets_v4 } from 'googleapis';

export interface SheetMeta {
  sheets?: { properties?: { title?: string } }[];
}

/** True if a tab with the given title exists in the spreadsheet metadata. */
export function tabExists(meta: SheetMeta, tab: string): boolean {
  return (meta.sheets ?? []).some((s) => s.properties?.title === tab);
}

/** Shape the A1 range + values grid for one tab (header row + symbols). */
export function valuesPayload(tab: string, symbols: string[]): { range: string; values: string[][] } {
  return { range: `'${tab}'!A1`, values: [['Symbol'], ...symbols.map((s) => [s])] };
}

function credsPath(): string {
  const p = process.env.GOOGLE_SHEETS_CREDENTIALS;
  if (!p) {
    throw new Error(
      'GOOGLE_SHEETS_CREDENTIALS is not set — point it at the service-account JSON key file.'
    );
  }
  return p;
}

async function client(): Promise<sheets_v4.Sheets> {
  const auth = new google.auth.GoogleAuth({
    keyFile: credsPath(),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth: await auth.getClient() as never });
}

/** Overwrite one tab's column A with `symbols` (header + rows). Creates the tab if missing. */
export async function writeTab(spreadsheetId: string, tab: string, symbols: string[]): Promise<void> {
  const api = await client();
  const meta = (await api.spreadsheets.get({ spreadsheetId })).data as SheetMeta;
  if (!tabExists(meta, tab)) {
    await api.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: tab } } }] },
    });
  }
  await api.spreadsheets.values.clear({ spreadsheetId, range: `'${tab}'!A:A` });
  const { range, values } = valuesPayload(tab, symbols);
  await api.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: 'RAW',
    requestBody: { values },
  });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS for `sheets-writer` pure-helper tests.

- [ ] **Step 6: Commit**

```bash
git add src/sheets-writer.ts test/sheets-writer.test.ts package.json package-lock.json
git commit -m "feat(sync): Google Sheets tab writer (service account)"
```

---

### Task 5: Read a shared watchlist (`src/driver.ts`)

**Files:**
- Modify: `src/driver.ts` (add `readSharedWatchlist` near `openWatchlist`/`readCurrentSymbols`)

This is browser integration; no unit test. Reuses `dismissPopups` and `readCurrentSymbols`.

- [ ] **Step 1: Add the function**

In `src/driver.ts`, after `readCurrentSymbols` (ends line ~285), add:

```typescript
/**
 * Read symbols from a TradingView *shared* watchlist public URL.
 * Navigates to the share page (uses the logged-in profile), then reuses the
 * same `[data-symbol-short]` scroll-read as named watchlists.
 */
export async function readSharedWatchlist(page: Page, shareUrl: string): Promise<string[]> {
  await page.goto(shareUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(4000);
  await dismissPopups(page);
  // Shared lists render rows with the same data-symbol-short attribute as the
  // sidebar watchlist. If a future TV change breaks this, add a shared-page
  // selector fallback here.
  await page.waitForSelector('[data-symbol-short]', { timeout: 20000 });
  return readCurrentSymbols(page, true); // full = exchange-qualified
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Manual smoke check (requires a real shared link)**

Create a throwaway `tmp-smoke.ts` at the repo root:

```typescript
import { getPage, closeBrowser } from './src/browser';
import { readSharedWatchlist } from './src/driver';

(async () => {
  const page = await getPage();
  const url = process.argv[2];
  console.log(await readSharedWatchlist(page, url));
  await closeBrowser();
})();
```

Run: `npx tsx tmp-smoke.ts "<a-real-shared-watchlist-url>"`
Expected: prints an array of `EXCHANGE:SYMBOL` strings. Then delete the file: `rm tmp-smoke.ts`.

> If login is required for the shared page, ensure `npm run login` has been run once. If the array is empty, the selector needs the fallback noted in Step 1 — inspect the page DOM and adjust.

- [ ] **Step 4: Commit**

```bash
git add src/driver.ts
git commit -m "feat(sync): read symbols from a shared watchlist URL"
```

---

### Task 6: Sync orchestrator (`src/sync.ts`)

**Files:**
- Create: `src/sync.ts`
- Test: `test/sync.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/sync.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot find module `../src/sync`.

- [ ] **Step 3: Write the implementation**

Create `src/sync.ts`:

```typescript
import type { Source } from './sources';
import { loadSources } from './sources';

export interface SyncDeps {
  sheetId: string;
  readList: (shareUrl: string) => Promise<string[]>;
  writeTab: (sheetId: string, tab: string, symbols: string[]) => Promise<void>;
  log: (msg: string) => void;
}

export interface SyncResult {
  written: number;
  skipped: number;
  failures: number;
}

/** Pure orchestration: read each source, write its tab, never let one failure abort the rest. */
export async function runSync(sources: Source[], deps: SyncDeps): Promise<SyncResult> {
  const res: SyncResult = { written: 0, skipped: 0, failures: 0 };
  for (const s of sources) {
    try {
      const symbols = await deps.readList(s.shareUrl);
      if (symbols.length === 0) {
        deps.log(`⚠️  ${s.name}: read 0 symbols — skipping write (suspected scrape miss)`);
        res.skipped++;
        continue;
      }
      await deps.writeTab(deps.sheetId, s.tab, symbols);
      deps.log(`✓ ${s.name} → tab "${s.tab}": ${symbols.length} symbols`);
      res.written++;
    } catch (e) {
      deps.log(`✗ ${s.name}: ${(e as Error).message}`);
      res.failures++;
    }
  }
  return res;
}

/** CLI entry: wire real Playwright + Sheets deps and run one sync. */
async function main(): Promise<void> {
  const sheetId = process.env.SYNC_SHEET_ID;
  if (!sheetId) throw new Error('SYNC_SHEET_ID is not set — the target spreadsheet id.');

  const { getPage, closeBrowser } = await import('./browser');
  const { readSharedWatchlist } = await import('./driver');
  const { writeTab } = await import('./sheets-writer');

  const sources = loadSources();
  const page = await getPage();
  try {
    const res = await runSync(sources, {
      sheetId,
      readList: (url) => readSharedWatchlist(page, url),
      writeTab,
      log: (m) => process.stderr.write(m + '\n'),
    });
    process.stderr.write(
      `\nSync done: ${res.written} written, ${res.skipped} skipped, ${res.failures} failed.\n`
    );
    process.exitCode = res.failures > 0 ? 1 : 0;
  } finally {
    await closeBrowser();
  }
}

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`fatal: ${(e as Error).message}\n`);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS for all `sync` tests.

- [ ] **Step 5: Add the npm script**

In `package.json` `scripts`, add:

```json
    "sync": "tsx src/sync.ts",
```

- [ ] **Step 6: Verify it compiles**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/sync.ts test/sync.test.ts package.json
git commit -m "feat(sync): orchestrator with empty-guard and per-list resilience"
```

---

### Task 7: Scheduling (launchd)

**Files:**
- Create: `scripts/com.tradingview-mcp.sync.plist`
- Create: `scripts/install-schedule.sh`

- [ ] **Step 1: Create the plist template**

Create `scripts/com.tradingview-mcp.sync.plist` (placeholders replaced by the installer):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.tradingview-mcp.sync</string>
  <key>WorkingDirectory</key><string>__REPO__</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string><string>-lc</string>
    <string>cd __REPO__ &amp;&amp; npm run sync</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>SYNC_SHEET_ID</key><string>__SHEET_ID__</string>
    <key>GOOGLE_SHEETS_CREDENTIALS</key><string>__CREDS__</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>15</integer><key>Minute</key><integer>30</integer></dict>
  <key>StandardOutPath</key><string>__REPO__/.cache/sync.log</string>
  <key>StandardErrorPath</key><string>__REPO__/.cache/sync.log</string>
</dict>
</plist>
```

- [ ] **Step 2: Create the installer**

Create `scripts/install-schedule.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
: "${SYNC_SHEET_ID:?set SYNC_SHEET_ID to the target spreadsheet id}"
: "${GOOGLE_SHEETS_CREDENTIALS:?set GOOGLE_SHEETS_CREDENTIALS to the service-account JSON path}"

DEST="$HOME/Library/LaunchAgents/com.tradingview-mcp.sync.plist"
mkdir -p "$REPO/.cache" "$HOME/Library/LaunchAgents"

sed -e "s#__REPO__#$REPO#g" \
    -e "s#__SHEET_ID__#$SYNC_SHEET_ID#g" \
    -e "s#__CREDS__#$GOOGLE_SHEETS_CREDENTIALS#g" \
    "$REPO/scripts/com.tradingview-mcp.sync.plist" > "$DEST"

launchctl unload "$DEST" 2>/dev/null || true
launchctl load "$DEST"
echo "Loaded $DEST — runs daily at 15:30. Edit StartCalendarInterval in the plist to change the time."
echo "Run now to test: launchctl start com.tradingview-mcp.sync ; tail -f $REPO/.cache/sync.log"
```

- [ ] **Step 3: Make it executable and verify syntax**

Run: `chmod +x scripts/install-schedule.sh && bash -n scripts/install-schedule.sh`
Expected: no output (syntax OK). Do **not** load it yet — that is the user's setup step (Task 8 docs).

- [ ] **Step 4: Commit**

```bash
git add scripts/com.tradingview-mcp.sync.plist scripts/install-schedule.sh
git commit -m "feat(sync): launchd schedule template + installer"
```

---

### Task 8: Documentation (`README.md`)

**Files:**
- Modify: `README.md` (add a "Watchlist → Google Sheet sync" section)

- [ ] **Step 1: Add the section**

Append to `README.md`:

```markdown
## Watchlist → Google Sheet sync

Mirror someone else's TradingView sector watchlists (shared public links) into one
Google Sheet, one tab per sector, on a daily schedule. The sheet then feeds
`tv_watchlist_data` (use its `tab` argument to pick a sector).

### One-time setup

1. **Friend:** for each sector list, enable **"Share list"** in advanced view and send
   you the public link. (Keep sharing on — the link stays live. Do **not** "copy to
   myself"; that is a static snapshot.)
2. **Sheet:** create one spreadsheet (e.g. `watchlist-sync`); set
   "Anyone with the link can view" (needed for the CSV read path).
3. **Service account:** in Google Cloud, enable the Sheets API, create a service
   account, download its JSON key, and share the spreadsheet with the service-account
   email as **Editor**.
4. **Config:** copy `watchlist-sources.example.json` → `watchlist-sources.json` and fill
   in `name`, `shareUrl`, `tab` per sector.
5. **Env:** set `GOOGLE_SHEETS_CREDENTIALS` (path to the JSON key) and `SYNC_SHEET_ID`
   (the spreadsheet id from its URL).

### Run

- Once, manually: `SYNC_SHEET_ID=... GOOGLE_SHEETS_CREDENTIALS=... npm run sync`
- Daily at 15:30 (Israel, pre-US-open): `bash scripts/install-schedule.sh`
  (edit `StartCalendarInterval` in `scripts/com.tradingview-mcp.sync.plist` to change the time).

Logs: `.cache/sync.log`. A list that reads 0 symbols is skipped (never wipes a good tab);
a broken link logs an error and the other lists still sync.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs(sync): document the watchlist → sheet sync setup"
```

---

## Self-Review

**Spec coverage:**
- Source config (gitignored + example) → Task 1. ✓
- Read shared list via Playwright reuse → Task 5. ✓
- Sheets writer via service account → Task 4. ✓
- Orchestrator + empty-guard + resilience → Task 6. ✓
- Extend read side with `tab` (gviz) → Tasks 2–3. ✓
- launchd scheduling → Task 7. ✓
- Error handling (broken link, 0-symbol guard, auth failure) → Tasks 4 & 6 + docs. ✓
- Setup docs → Task 8. ✓

**Type consistency:** `Source {name,shareUrl,tab}` (Task 1) used identically in Tasks 6.
`writeTab(spreadsheetId, tab, symbols)` (Task 4) matches the `SyncDeps.writeTab` signature
and the real wiring in Task 6. `fetchSheetSymbols(input, tab?)` (Task 2) matches the
caller in Task 3. `readSharedWatchlist(page, url)` (Task 5) matches `readList` wiring in Task 6.

**Placeholders:** none — every code/command step is concrete. The plist `__REPO__` etc.
are intentional installer-substituted tokens, documented in Task 7.

**Out of scope (unchanged):** bi-directional sync, inline notes/merge, cloud execution.
