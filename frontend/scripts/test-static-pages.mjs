// Help, policy and contact pages + app-wide not-found. Run against a built frontend (production build):
//   npx next start -p 3101 &
//   FRONTEND_URL=http://localhost:3101 PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/test-static-pages.mjs
// Only the browser's API calls are faked. These pages are static, so they need no backend.
import assert from 'node:assert/strict';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.FRONTEND_URL || 'http://localhost:3101';
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

const contactPosts = [];
await page.route('https://challenges.cloudflare.com/**', (route) =>
  route.fulfill({ contentType: 'application/javascript', body: "window.turnstile={render(el,o){setTimeout(()=>o.callback('captcha-1'),0);return 'w1'},remove(){}};" }),
);
await page.route('**/api/v1/**', (route) => {
  const path = new URL(route.request().url()).pathname.replace('/api/v1', '');
  if (path === '/contact') {
    contactPosts.push(route.request().postDataJSON());
    return route.fulfill({ status: 202, json: { success: true, data: null } });
  }
  const data = path === '/catalog/categories' ? [{ id: 'c1', name: 'Kitchen and Dining', slug: 'kitchen-and-dining', children: [] }] : null;
  return route.fulfill({ json: { success: true, data } });
});

const PAGES = [
  ['/help', 'Help & FAQs'],
  ['/shipping', 'Shipping & delivery'],
  ['/returns', 'Returns, cancellations & refunds'],
  ['/privacy', 'Privacy policy'],
  ['/terms', 'Terms of use & sale'],
  ['/contact', 'Contact us'],
];
const NOT_FOUND_HEADING = 'We can’t find that page';
const WIDTHS = [320, 375, 768, 1440];

async function open(path) {
  const response = await page.goto(`${base}${path}`);
  // visible only: while React streams a page, the incoming copy waits in a hidden <div> next to the shown one
  await page.locator('footer').filter({ visible: true }).first().waitFor();
  return response;
}
async function assertNoOverflow(label) {
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  assert.ok(wide <= 1, `${label}: page is ${wide}px wider than the screen`);
}

try {
  // ---------------------------------------------------------------------------------------------- each page
  for (const [path, heading] of PAGES) {
    const response = await open(path);
    assert.equal(response.status(), 200, `${path} status`);
    assert.equal(await page.getByRole('heading', { level: 1 }).count(), 1, `${path}: exactly one h1`);
    await page.getByRole('heading', { level: 1, name: heading, exact: true }).waitFor();
    assert.match(await page.title(), /\| Yalli$/, `${path}: title`);
    assert.ok((await page.locator('main h2').count()) >= 2, `${path}: has sections`);
    assert.equal(await page.locator('main#content').count(), 1, `${path}: main landmark`);
    assert.equal(await page.locator('footer').getByText(/subscrib/i).count(), 0, `${path}: no subscribe text`);
  }
  console.log('PASS 6 pages render one h1, a title, sections and a main landmark');

  // The three legal pages carry a date; none of them claims a lawyer checked them.
  for (const path of ['/privacy', '/terms', '/returns']) {
    await open(path);
    await page.getByText('Last updated: 19 November 2026').waitFor();
    assert.equal(await page.getByText(/lawyer|legal review|reviewed by/i).count(), 0, `${path}: no review claim`);
  }

  // Store-owner reminders are for development only.
  if (!process.env.EXPECT_OWNER_NOTES) {
    await open('/contact');
    assert.equal(await page.getByText('To be added by the store owner').count(), 0, 'owner reminders must not reach customers');
  }

  // ---------------------------------------------------------------------------------------------- footer
  await open('/help');
  const footerHrefs = await page.locator('footer a[href^="/"]').evaluateAll((els) => [...new Set(els.map((a) => a.getAttribute('href')))]);
  for (const [path] of PAGES) assert.ok(footerHrefs.includes(path), `footer links to ${path}`);
  assert.equal(await page.locator('footer form').count(), 0, 'footer has no form');
  assert.equal(await page.locator('footer input').count(), 0, 'footer has no email box');
  assert.ok(footerHrefs.includes('/account/profile'), 'footer points to the real email-offers switch');
  // Category links need the catalogue backend, so they are checked by the catalogue script instead.
  for (const href of footerHrefs.filter((h) => !h.startsWith('/catalog'))) {
    const response = await open(href);
    assert.ok(response.status() < 400, `footer link ${href} returned ${response.status()}`);
    assert.equal(await page.getByRole('heading', { name: NOT_FOUND_HEADING }).count(), 0, `footer link ${href} is a 404`);
  }
  console.log(`PASS footer links all resolve (${footerHrefs.filter((h) => !h.startsWith('/catalog')).length} checked), no subscribe form`);

  // ---------------------------------------------------------------------------------------------- 404
  const missing = await page.goto(`${base}/definitely-not-a-real-page`);
  assert.equal(missing.status(), 404);
  await page.getByRole('heading', { level: 1, name: NOT_FOUND_HEADING }).waitFor();
  await page.getByRole('link', { name: 'Go to the home page' }).waitFor();
  await page.getByRole('link', { name: 'Browse products' }).waitFor();
  await page.getByRole('link', { name: 'Help centre' }).waitFor();
  assert.equal(await page.getByText(/at\s.+\.(js|tsx?):\d+/).count(), 0, '404 shows no stack');
  console.log('PASS unknown URL shows the friendly not-found page with a 404 status');

  // ---------------------------------------------------------------------------------------------- old OpenCart links
  // Routes that need no data file (the test build has an empty map): a 301 from the proxy with the right target, and a
  // 404 for an unknown product. The map itself is unit-tested (src/lib/legacy-redirects.spec.ts).
  for (const [from, to] of [
    ['/index.php?route=information/contact', '/contact'],
    ['/index.php?route=product/special', '/specials'],
    ['/index.php?route=product/search&search=steel%20bottle', '/catalog?q=steel%20bottle'],
    ['/index.php?route=common/home', '/'],
    ['/index.php', '/'],
    ['/en-gb?route=information/contact', '/contact'],
    ['/?route=information/contact', '/contact'],
    ['/index.php?route=product/search&amp;search=lamp', '/catalog?q=lamp'], // &amp; from feeds and exports
    ['/delivery', '/shipping'],
  ]) {
    const res = await fetch(`${base}${from}`, { redirect: 'manual' });
    assert.equal(res.status, 301, `${from} answered ${res.status}, not a 301`);
    assert.ok(!/^https?:/i.test(res.headers.get('location')), `${from}: the Location is relative (no internal host)`);
    assert.equal(new URL(res.headers.get('location'), base).pathname + new URL(res.headers.get('location'), base).search, to, `${from} redirects to ${to}`);
  }
  for (const path of [
    '/index.php?route=product/product&product_id=999999',
    '/index.php?route=constructor',
    '/old-keyword-nobody-knows',
    '/%ZZ', // malformed percent-encoding: a 404, not a 500
    '/products/no-such-product-anywhere', // its own page's not-found, not a redirect
    '/_next/static/chunks/no-such-chunk.js',
  ]) {
    const res = await fetch(`${base}${path}`, { redirect: 'manual' });
    assert.equal(res.status, 404, `${path} answered ${res.status}, not a 404`);
  }
  // pages and the API proxy are never touched by the old-link proxy
  assert.equal((await fetch(`${base}/help`, { redirect: 'manual' })).status, 200);
  assert.equal((await fetch(`${base}/brands`, { redirect: 'manual' })).status, 200);
  const api = await fetch(`${base}/api/v1/catalog/categories`, { redirect: 'manual' });
  assert.ok(![301, 308].includes(api.status), `the API proxy answered ${api.status}`);
  console.log('PASS old OpenCart links: 301s to the new pages, 404 for unknown ones, pages and the API untouched');

  // ---------------------------------------------------------------------------------------------- behaviour
  await open('/help');
  const first = page.locator('details').first();
  assert.equal(await first.evaluate((d) => d.open), false, 'FAQ starts closed');
  await first.locator('summary').click();
  assert.equal(await first.evaluate((d) => d.open), true, 'FAQ opens');

  await open('/privacy');
  const toc = page.getByRole('navigation', { name: 'On this page' }).getByRole('link').nth(2);
  const target = (await toc.getAttribute('href')).slice(1);
  await toc.click();
  assert.equal(await page.evaluate(() => location.hash), `#${target}`);
  assert.ok(await page.locator(`#${target}`).isVisible(), 'contents link lands on its section');
  await open('/privacy');
  await page.getByText('never to our servers', { exact: false }).first().waitFor();
  await page.getByText('Google Fonts', { exact: false }).first().waitFor(); // third-party font load is disclosed

  await open('/returns');
  await page.getByRole('cell', { name: '2–7 working days' }).waitFor();
  assert.equal(await page.locator('table caption').count(), 1, 'refund table has a caption');

  // ---------------------------------------------------------------------------------------------- layout
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    for (const [path] of PAGES) {
      await open(path);
      await assertNoOverflow(`${path} @${width}`);
    }
    await page.goto(`${base}/definitely-not-a-real-page`);
    await page.locator('footer').waitFor();
    await assertNoOverflow(`404 @${width}`);
  }
  console.log('PASS no horizontal overflow at 320 / 375 / 768 / 1440');

  // contact form: local check, then a plain-text message with the order number (and the captcha when configured)
  await page.setViewportSize({ width: 1280, height: 900 });
  await open('/contact');
  const form = page.locator('form', { has: page.getByRole('heading', { name: 'Send us a message' }) });
  await form.getByLabel('Your name').fill('Asha Kumar');
  await form.getByLabel('Email (we reply here)').fill('asha@example.test');
  await form.getByLabel('Order number (optional)').fill('yl26-1001');
  await form.getByLabel('Message').fill('short');
  await form.getByRole('button', { name: 'Send message' }).click();
  await form.getByText('Please tell us a little more').waitFor();
  assert.equal(contactPosts.length, 0, 'too-short message is not sent');
  await form.getByLabel('Message').fill('My parcel says delivered but it has not arrived.');
  await form.getByRole('button', { name: 'Send message' }).click();
  await page.getByText('Thanks, we have your message.').waitFor();
  assert.equal(contactPosts.length, 1);
  const sent = contactPosts[0];
  assert.equal(sent.orderNumber, 'YL26-1001');
  assert.equal(sent.topic, 'ORDER');
  assert.equal('website' in sent, false, 'the honeypot is not sent when empty');
  if (process.env.EXPECT_CAPTCHA === '1') assert.equal(sent.captchaToken, 'captcha-1');
  console.log('PASS contact form sends a checked, plain message');

  assert.deepEqual(pageErrors, [], `uncaught page errors: ${pageErrors.join(' | ')}`);
  console.log('PASS: help, shipping, returns, privacy, terms, contact and 404 pages');
} finally {
  await browser.close();
}
