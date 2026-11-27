// Automated accessibility check (axe-core) of the main public pages, against the catalogue mock API.
// Fails on any SERIOUS or CRITICAL violation (WCAG 2.1 A/AA rules). Run through `npm run test:browser` (needs the mock API
// and a test build), or: FRONTEND_URL=http://localhost:3199 PLAYWRIGHT_MODULE=... node scripts/test-a11y.mjs
// Automated checks find only part of the problems: keyboard and screen-reader passes are still needed (docs/PENDING.md).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const AXE = require.resolve('axe-core/axe.min.js');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const BASE = process.env.FRONTEND_URL || 'http://localhost:3101';
const PAGES = ['/', '/catalog', '/catalog/collection-1', '/products/product-0', '/brands', '/specials', '/help', '/returns', '/contact', '/cart', '/auth/login', '/auth/register'];

const browser = await chromium.launch({ headless: true });
const failures = [];
const colours = new Set(); // A11Y_COLORS=1: print the failing colour pairs
try {
  for (const width of [1280, 375]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    // a stub keeps third-party scripts out of the run (no network)
    await context.route('https://challenges.cloudflare.com/**', (r) => r.fulfill({ contentType: 'application/javascript', body: 'window.turnstile={render(){return "w"},remove(){}};' }));
    const page = await context.newPage();
    for (const path of PAGES) {
      await page.goto(`${BASE}${path}`, { waitUntil: 'load' });
      await page.waitForTimeout(300);
      await page.addScriptTag({ path: AXE });
      const result = await page.evaluate(async () =>
        window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }, resultTypes: ['violations'] }),
      );
      for (const v of result.violations.filter((x) => x.impact === 'serious' || x.impact === 'critical')) {
        if (process.env.A11Y_COLORS)
          for (const n of v.nodes) {
            const d = n.any?.[0]?.data;
            if (d?.fgColor) colours.add(`${d.fgColor} on ${d.bgColor} = ${d.contrastRatio} (need ${d.expectedContrastRatio})`);
          }
        failures.push(`${path} @${width}px: ${v.id} (${v.impact}) ${v.help} -> ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
      }
    }
    await context.close();
  }
  if (failures.length) console.error(failures.join('\n'));
  if (colours.size) console.error([...colours].join('\n'));
  assert.equal(failures.length, 0, `${failures.length} serious/critical accessibility violations`);
  console.log(`PASS: no serious or critical axe violations on ${PAGES.length} pages at 1280 and 375 px`);
} finally {
  await browser.close();
}
