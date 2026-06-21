import { chromium, type BrowserContext, type Page } from 'playwright';
import * as os from 'os';
import * as path from 'path';

export const PROFILE_DIR =
  process.env.TV_PROFILE_DIR || path.join(os.homedir(), '.cache', 'tradingview-mcp', 'profile');
const HEADLESS = !process.env.TV_HEADED;

let ctx: BrowserContext | null = null;
let pageRef: Page | null = null;

/** Lazily launch a persistent context (logged-in profile) and reuse it. */
export async function getPage(): Promise<Page> {
  if (pageRef && !pageRef.isClosed()) return pageRef;
  ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: HEADLESS,
    viewport: { width: 1400, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  pageRef = ctx.pages()[0] ?? (await ctx.newPage());
  pageRef.setDefaultTimeout(20000);
  pageRef.setDefaultNavigationTimeout(45000);
  return pageRef;
}

export async function closeBrowser(): Promise<void> {
  try {
    await ctx?.close();
  } catch {
    /* ignore */
  }
  ctx = null;
  pageRef = null;
}

for (const sig of ['exit', 'SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void closeBrowser();
  });
}
