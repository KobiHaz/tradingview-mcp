import { chromium } from 'playwright';
import { PROFILE_DIR } from './browser';

async function main() {
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1400, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto('https://www.tradingview.com/#signin', { waitUntil: 'domcontentloaded' });
  process.stderr.write('⌛ Log into TradingView, then close the browser window when done.\n');
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, 10 * 60 * 1000);
    ctx.on('close', () => {
      clearTimeout(t);
      resolve();
    });
  });
  await ctx.close().catch(() => {});
  process.stderr.write('✓ Login flow completed.\n');
  process.exit(0);
}
main();
