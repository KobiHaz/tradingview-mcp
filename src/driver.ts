import type { Page } from 'playwright';

const SCROLL_DEADLINE_MS = 30000;

// Driver diagnostics go to stderr (stdout is the MCP stdio channel).
function log(msg: string): void {
  process.stderr.write(`${new Date().toISOString()} ${msg}\n`);
}

// TradingView DOM selectors — update when TV changes their HTML.
export const SELECTORS = {
  watchlistPanel: 'div[data-name="watchlists-dialog"], div.tv-screener-table',
  watchlistTitleButton: 'button[data-name="watchlists-button"]',
  watchlistItem: (name: string) => `div[data-name="watchlists-menu"] >> text="${name}"`,
  addSymbolButton: 'button[data-name="add-symbol-button"]',
  symbolInput: 'input[data-name="symbol-search-input"]',
  symbolRow: 'div[data-name="list-item"]',
  symbolRowText: 'div[data-name="list-item"] [class*="symbolNameText"]',
  loginButton: 'button[data-name="header-user-menu-sign-in"]',
};

export async function isLoggedIn(page: Page): Promise<boolean> {
  const signInBtn = await page.$(SELECTORS.loginButton);
  return !signInBtn;
}

export async function dismissPopups(page: Page): Promise<void> {
  const closeSelectors = [
    'button[data-name="close"]',
    'button[aria-label="Close"]',
    'button[aria-label="close"]',
    '[data-dialog-name] [data-name="close"]',
    'div[role="dialog"] button[aria-label*="lose"]',
    'div[class*="dialogClose"]',
    'span[class*="closeButton"]',
  ];
  for (let attempt = 0; attempt < 3; attempt++) {
    let closed = false;
    for (const sel of closeSelectors) {
      const els = await page.$$(sel);
      for (const el of els) {
        try {
          if (await el.isVisible()) {
            await el.click({ timeout: 1500 });
            log(`  ✕ dismissed popup via ${sel}`);
            closed = true;
            await page.waitForTimeout(400);
          }
        } catch {
          /* ignore */
        }
      }
    }
    if (!closed) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      break;
    }
  }
}

export async function tryWithin<T>(timeout: number, op: () => Promise<T>): Promise<T | null> {
  try {
    return await Promise.race([
      op(),
      new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), timeout)),
    ]);
  } catch {
    return null;
  }
}

export async function openWatchlist(
  page: Page,
  name: string,
  createIfMissing: boolean = true
): Promise<boolean> {
  log(`↳ Looking for watchlist "${name}"...`);
  await dismissPopups(page);

  const titleBtn = await page.waitForSelector(SELECTORS.watchlistTitleButton, {
    timeout: 15000,
  });
  await titleBtn.click();
  await page.waitForTimeout(700);

  const openListBtn = await tryWithin(3000, async () => {
    const el = await page.getByText('Open list', { exact: false }).first().elementHandle();
    return el;
  });
  if (openListBtn) {
    log('  ↳ clicking "Open list…"');
    await openListBtn.click();
    await page.waitForTimeout(1500);

    const item = await tryWithin(3000, async () => {
      return page.getByText(name, { exact: true }).first().elementHandle();
    });
    if (item) {
      log(`✓ Found "${name}" — clicking`);
      await item.click({ force: true });
      await page.waitForTimeout(1500);
      await page.keyboard.press('Escape').catch(() => undefined);
      return true;
    }
    log(`  "${name}" not in list browser, closing modal`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  }

  if (!createIfMissing) {
    log(`  ⏭  "${name}" missing and target empty — skipping (no need to create)`);
    return false;
  }

  // Create via "Create new list"
  log(`⚠️ "${name}" not found; creating new list...`);
  const stillOpen = await tryWithin(1500, async () => {
    return page.getByText('Create new list', { exact: false }).first().elementHandle();
  });
  if (!stillOpen) {
    await titleBtn.click();
    await page.waitForTimeout(700);
  }
  const createBtn = await tryWithin(3000, async () => {
    return page.getByText('Create new list', { exact: false }).first().elementHandle();
  });
  if (!createBtn) {
    throw new Error('Could not find "Create new list" option in TradingView menu.');
  }
  await createBtn.click();
  await page.waitForTimeout(1200);

  let nameInput =
    (await tryWithin(2000, () => page.$('input[type="text"]:visible'))) ??
    (await tryWithin(2000, () => page.$('input:visible')));
  if (!nameInput) {
    nameInput = await page
      .evaluate(() => {
        const el = document.activeElement;
        return el && el.tagName === 'INPUT' ? (el as HTMLInputElement) : null;
      })
      .then((res) => (res ? page.$('input:focus') : null));
  }
  if (!nameInput) {
    throw new Error('Could not find name input for new watchlist.');
  }
  await nameInput.fill(name);
  await page.waitForTimeout(400);
  await nameInput.press('Enter');
  await page.waitForTimeout(1500);
  log(`✓ Created watchlist "${name}"`);
  return true;
}

export async function readCurrentSymbols(page: Page, full = false): Promise<string[]> {
  const all = new Set<string>();

  const containerHandle = await page.evaluateHandle(() => {
    const candidates = [
      '[data-name="symbol-list-wrap"]',
      'div[class*="symbolListWrapper"]',
      'div[class*="symbol-list"]',
      'div[class*="list-container"]',
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (el && el.scrollHeight > el.clientHeight) return el;
    }
    const sample = document.querySelector('[data-symbol-short]');
    if (sample) {
      let p = sample.parentElement;
      while (p) {
        const cs = getComputedStyle(p);
        if (
          (cs.overflowY === 'auto' || cs.overflowY === 'scroll') &&
          p.scrollHeight > p.clientHeight
        ) {
          return p as HTMLElement;
        }
        p = p.parentElement;
      }
    }
    return null;
  });
  const container = containerHandle.asElement();

  const snapshot = async (): Promise<number> => {
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
    let added = 0;
    for (const s of symbols)
      if (!all.has(s)) {
        all.add(s);
        added++;
      }
    return added;
  };

  await snapshot();

  if (container) {
    const { scrollHeight, clientHeight } = await container.evaluate((el) => ({
      scrollHeight: (el as HTMLElement).scrollHeight,
      clientHeight: (el as HTMLElement).clientHeight,
    }));
    const step = Math.max(100, clientHeight - 30);
    let pos = 0;
    let stagnant = 0;
    const scrollDeadline = Date.now() + SCROLL_DEADLINE_MS;
    while (pos < scrollHeight + step) {
      if (Date.now() > scrollDeadline) {
        // No replace mode in the driver — caller decides semantics.
        // Always use the partial read with a warning (never throw here).
        log(`  ⚠️ watchlist scroll exceeded ${Math.round(SCROLL_DEADLINE_MS / 1000)}s — using partial read`);
        break;
      }
      await container.evaluate((el, p) => {
        (el as HTMLElement).scrollTop = p;
      }, pos);
      await page.waitForTimeout(250);
      const added = await snapshot();
      if (added === 0) {
        stagnant++;
        if (stagnant >= 3) break;
      } else {
        stagnant = 0;
      }
      pos += step;
    }
    await container
      .evaluate((el) => {
        (el as HTMLElement).scrollTop = 0;
      })
      .catch(() => undefined);
  } else {
    log(`  (no scrollable watchlist container found — using single-snapshot count)`);
  }

  const list = [...all];
  log(`  (scrolled watchlist → ${list.length} unique rows)`);
  return list;
}

export async function jsClick(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) return false;
    el.click();
    return true;
  }, selector);
}

export async function addSymbolsBulk(
  page: Page,
  symbols: string[]
): Promise<{ added: string[]; failed: string[] }> {
  const added: string[] = [];
  const failed: string[] = [];
  if (symbols.length === 0) return { added, failed };

  log(`  📥 opening Add Symbol dialog for ${symbols.length} ticker(s)...`);

  await dismissPopups(page);
  await page.keyboard.press('Escape').catch(() => undefined);
  await page.waitForTimeout(500);
  await page
    .click('canvas[data-name="pane-canvas"]', { position: { x: 200, y: 300 }, force: true })
    .catch(() => undefined);
  await page.waitForTimeout(300);

  const opened = await jsClick(page, SELECTORS.addSymbolButton);
  if (!opened) {
    log('  ⚠️ Add Symbol button not found in DOM');
    return { added, failed: symbols };
  }
  await page.waitForTimeout(1200);

  let input =
    (await tryWithin(2500, () => page.$(SELECTORS.symbolInput))) ??
    (await tryWithin(2500, () => page.$('input[placeholder*="ymbol" i]'))) ??
    (await tryWithin(2500, () => page.$('input[role="combobox"]'))) ??
    (await tryWithin(2500, () => page.$('input[type="text"]:focus')));
  if (!input) {
    log('  ⚠️ symbol input not visible after opening Add Symbol');
    return { added, failed: symbols };
  }

  for (const symbol of symbols) {
    try {
      log(`    + ${symbol}`);
      await input.fill('');
      await page.waitForTimeout(150);
      await input.type(symbol, { delay: 30 });
      await page.waitForTimeout(900);
      await input.press('Enter');
      await page.waitForTimeout(700);
      added.push(symbol);
    } catch (e) {
      log(`    ⚠️ ${symbol} failed: ${(e as Error).message}`);
      failed.push(symbol);
    }
  }

  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  return { added, failed };
}

export async function removeSymbol(page: Page, symbol: string): Promise<boolean> {
  const normalized = symbol.split(':').pop()!.toUpperCase();
  const sel = `[data-symbol-short="${normalized}"]`;
  const isPresent = () => page.evaluate((s) => !!document.querySelector(s), sel);
  const getRow = async () => {
    const h = await page.evaluateHandle((s) => document.querySelector(s) as HTMLElement | null, sel);
    return h.asElement();
  };

  if (!(await isPresent())) return true; // already absent → nothing to do

  // Strategy 1 — select row + Delete (headless-safe, primary).
  let el = await getRow();
  if (el) {
    await el.scrollIntoViewIfNeeded().catch(() => undefined);
    await el.click().catch(() => undefined);
    await page.waitForTimeout(300);
    await page.keyboard.press('Delete');
    await page.waitForTimeout(500);
    if (!(await isPresent())) return true;
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(500);
    if (!(await isPresent())) return true;
  }

  // Strategy 2 — hover-revealed remove control (span.removeButton-*).
  el = await getRow();
  if (el) {
    await el.hover().catch(() => undefined);
    await page.waitForTimeout(300);
    const rm = await tryWithin(1500, async () => el!.$('[class*="removeButton"]'));
    if (rm) {
      await rm.click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(500);
      if (!(await isPresent())) return true;
    }
  }

  // Strategy 3 — legacy right-click → Remove (works only in headed mode).
  el = await getRow();
  if (el) {
    await el.click({ button: 'right' });
    await page.waitForTimeout(700);
    const removeBtn = await tryWithin(2500, async () =>
      page.getByText('Remove', { exact: false }).first().elementHandle()
    );
    if (removeBtn) {
      await removeBtn.click({ force: true });
      await page.waitForTimeout(500);
    }
    await page.keyboard.press('Escape').catch(() => undefined);
    if (!(await isPresent())) return true;
  }

  return false;
}

// Map friendly interval forms to TradingView interval codes. Unknown values
// pass through unchanged. "1M" is intentionally NOT mapped (ambiguous: monthly
// is "M", one-minute is "1").
export function tvInterval(raw: string): string {
  const s = raw.trim().toUpperCase();
  const map: Record<string, string> = {
    '1D': 'D', D: 'D', DAY: 'D', DAILY: 'D',
    '1W': 'W', W: 'W', WEEK: 'W', WEEKLY: 'W',
    M: 'M', MONTH: 'M', MONTHLY: 'M',
    '1H': '60', '60': '60', '60M': '60',
    '4H': '240', '240': '240', '2H': '120', '120': '120',
    '30': '30', '15': '15', '5': '5', '1': '1',
  };
  return map[s] ?? s;
}

// Candidate selectors for the main chart area (the center layout region,
// excluding the right watchlist panel and the left drawing toolbar). Fallback
// chain because TradingView renames classes; first match with a sane box wins.
const CHART_AREA_SELECTORS = [
  '.layout__area--center',
  'div[class*="layout__area--center"]',
  '.chart-gui-wrapper',
  'table.chart-markup-table',
];

export async function chartClip(
  page: Page
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  for (const sel of CHART_AREA_SELECTORS) {
    const el = await page.$(sel).catch(() => null);
    if (!el) continue;
    const box = await el.boundingBox().catch(() => null);
    if (box && box.width > 200 && box.height > 200) return box;
  }
  return null;
}

export async function captureChart(
  page: Page,
  symbol: string,
  interval: string | null,
  outPath: string
): Promise<void> {
  let url = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(symbol)}`;
  if (interval) url += `&interval=${encodeURIComponent(tvInterval(interval))}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(6000);
  await dismissPopups(page);
  const clip = await chartClip(page);
  if (!clip) log('  (chart-area selector not found — full-viewport screenshot)');
  await page.screenshot({ path: outPath, fullPage: false, ...(clip ? { clip } : {}) });
}

