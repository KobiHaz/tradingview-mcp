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
        deps.log(`⚠️  ${s.name}: read 0 symbols — skipping write (suspected fetch/parse miss)`);
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

/** CLI entry: wire real HTTP + Sheets deps and run one sync. No browser. */
async function main(): Promise<void> {
  const sheetId = process.env.SYNC_SHEET_ID;
  if (!sheetId) throw new Error('SYNC_SHEET_ID is not set — the target spreadsheet id.');

  const { fetchSharedWatchlist } = await import('./shared-watchlist');
  const { writeTab } = await import('./sheets-writer');

  const res = await runSync(loadSources(), {
    sheetId,
    readList: fetchSharedWatchlist,
    writeTab,
    log: (m) => process.stderr.write(m + '\n'),
  });
  process.stderr.write(
    `\nSync done: ${res.written} written, ${res.skipped} skipped, ${res.failures} failed.\n`
  );
  process.exitCode = res.failures > 0 ? 1 : 0;
}

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`fatal: ${(e as Error).message}\n`);
    process.exit(1);
  });
}
