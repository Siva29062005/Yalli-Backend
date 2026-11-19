// Compare page, product-card ratings and "Write a review" (Chromium via Playwright).
// Needs the catalog mock API + a storefront pointed at it (see test-catalog.mjs):
//   node scripts/test-catalog.mjs --mock-api 4010 &
//   API_INTERNAL_URL=http://127.0.0.1:4010/api/v1 npx next start -p 3101 &
//   node scripts/test-compare-reviews.mjs
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const BASE = process.env.FRONTEND_URL || 'http://localhost:3101';
const MOCK = process.env.MOCK_API || 'http://127.0.0.1:4010/api/v1';
const SHOTS = '/tmp/yalli-shots/compare';
mkdirSync(SHOTS, { recursive: true });
const ok = (data) => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data }) });
const fail = (status, message, code) => ({ status, contentType: 'application/json', body: JSON.stringify({ success: false, message, error: { code } }) });
const me = { id: 'u1', email: 'priya@example.com', firstName: 'Priya', lastName: 'R', emailVerified: true, mfaEnabled: false, roles: ['CUSTOMER'] };
const emptyCart = { items: [], itemCount: 0, coupon: null, couponError: null, totals: { subtotalMinor: 0, discountMinor: 0, shippingMinor: 0, gstIncludedMinor: 0, totalMinor: 0, currency: 'INR' } };

const browser = await chromium.launch();
async function test(name, fn, { signedIn = false, viewport = { width: 1280, height: 900 }, reviewReply } = {}) {
  const context = await browser.newContext({ viewport });
  const calls = [];
  if (signedIn) await context.addInitScript(() => sessionStorage.setItem('yalli_customer_csrf', 'csrf'));
  // Browser-side calls: catalogue reads are proxied to the mock server, account calls are faked here.
  await context.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace('/api/v1', '');
    calls.push({ path, method: req.method(), body: req.postDataJSON?.() ?? null });
    if (path === '/auth/refresh') return signedIn ? route.fulfill(ok({ accessToken: 'at', csrfToken: 'csrf' })) : route.fulfill(fail(401, 'No session', 'UNAUTHENTICATED'));
    if (path === '/me') return route.fulfill(ok(me));
    if (path === '/me/wishlist') return route.fulfill(ok([]));
    if (path === '/cart') return route.fulfill(ok(emptyCart));
    if (/\/reviews$/.test(path) && req.method() === 'POST') return route.fulfill(reviewReply ?? ok({ id: 'r9', status: 'PENDING' }));
    if (path.startsWith('/catalog/')) {
      const r = await fetch(`${MOCK}${path}`);
      return route.fulfill({ status: r.status, contentType: 'application/json', body: await r.text() });
    }
    return route.fulfill(fail(404, `Unmocked ${path}`, 'NOT_FOUND'));
  });
  const page = await context.newPage();
  try {
    await fn(page, calls);
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n`, e);
    await page.screenshot({ path: `${SHOTS}/FAIL-${name.replace(/\W+/g, '-').slice(0, 50)}.png`, fullPage: true }).catch(() => {});
    process.exitCode = 1;
  } finally {
    await context.close();
  }
}
const main = (page) => page.locator('main:visible');
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

await test('product cards show ratings only when there are reviews', async (page) => {
  await page.goto(`${BASE}/catalog`);
  await main(page).locator('article').first().waitFor();
  await main(page).locator('[aria-label="Rated 4.5 out of 5 from 12 reviews"]').first().waitFor();
  const first = main(page).locator('article').first(); // product-0 has no reviews
  assert.equal(await first.locator('[aria-label^="Rated"]').count(), 0);
});

await test('compare: empty state, add from product pages, real data, remove, stale slug dropped', async (page) => {
  await page.goto(`${BASE}/compare`);
  await main(page).getByText('No products in your comparison list yet.').waitFor();
  for (const slug of ['product-1', 'product-2']) {
    await page.goto(`${BASE}/products/${slug}`);
    await main(page).getByRole('button', { name: 'Add to compare' }).click();
    await main(page).getByRole('link', { name: /In your comparison/ }).waitFor();
  }
  // A product that was unpublished since it was added is dropped silently.
  await page.evaluate(() => {
    const k = 'yalli-storefront-v1';
    const v = JSON.parse(localStorage.getItem(k));
    v.state.compareSlugs.push('gone-product');
    localStorage.setItem(k, JSON.stringify(v));
  });
  await page.goto(`${BASE}/compare`);
  const table = page.getByRole('table', { name: 'Product comparison' });
  await table.waitFor();
  await table.getByRole('link', { name: 'Kitchen essential 1' }).waitFor();
  await table.getByRole('link', { name: 'Kitchen essential 2' }).waitFor();
  await table.getByText('Stainless steel').first().waitFor(); // attribute from the API
  await table.getByText('Prestige').first().waitFor();
  assert.equal(await page.getByText('gone-product').count(), 0);
  await page.screenshot({ path: `${SHOTS}/compare-desktop.png`, fullPage: true });
  for (const width of [320, 375, 768]) {
    await page.setViewportSize({ width, height: 800 });
    assert.ok((await overflow(page)) <= 0, `page overflow at ${width}px (the table should scroll inside its card)`);
  }
  await page.screenshot({ path: `${SHOTS}/compare-mobile.png`, fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await table.getByRole('button', { name: 'Remove Kitchen essential 1 from comparison' }).click();
  await page.getByText('Add another product to compare side by side.').waitFor();
  await page.getByRole('button', { name: 'Clear all' }).click();
  await main(page).getByText('No products in your comparison list yet.').waitFor();
});

await test('reviews: signed-out visitors get a sign-in link back to the reviews', async (page) => {
  await page.goto(`${BASE}/products/product-1`);
  const link = main(page).getByRole('link', { name: 'Sign in to write a review' });
  await link.waitFor();
  assert.match(await link.getAttribute('href'), /next=%2Fproducts%2Fproduct-1%23reviews/);
});

await test('reviews: validates, then submits rating + text only', async (page, calls) => {
  await page.goto(`${BASE}/products/product-1`);
  await main(page).getByRole('button', { name: 'Write a review' }).click();
  const form = page.getByRole('form', { name: 'Write a review' });
  await form.getByRole('button', { name: 'Submit review' }).click();
  await form.getByText('Choose a star rating.').waitFor();
  await form.getByText('Write at least 10 characters.').waitFor();
  await form.getByRole('button', { name: '4 stars' }).click();
  await form.getByLabel('Title (optional)').fill('Solid bottle');
  await form.getByLabel('Your review').fill('Keeps water cold through a whole day outside.');
  await page.screenshot({ path: `${SHOTS}/review-form.png` });
  await form.getByRole('button', { name: 'Submit review' }).click();
  await main(page).getByText(/will appear once it has been checked/).waitFor();
  const post = calls.find((c) => c.method === 'POST' && c.path === '/catalog/products/product-1/reviews');
  assert.deepEqual(post.body, { rating: 4, title: 'Solid bottle', body: 'Keeps water cold through a whole day outside.' });
}, { signedIn: true });

await test('reviews: shows the server reason when the customer is not eligible', async (page) => {
  await page.goto(`${BASE}/products/product-1`);
  await main(page).getByRole('button', { name: 'Write a review' }).click();
  const form = page.getByRole('form', { name: 'Write a review' });
  await form.getByRole('button', { name: '5 stars' }).click();
  await form.getByLabel('Your review').fill('Trying to review without buying.');
  await form.getByRole('button', { name: 'Submit review' }).click();
  await form.getByText('Only customers who received this product can review it').waitFor();
}, { signedIn: true, reviewReply: fail(403, 'Only customers who received this product can review it', 'REVIEW_REQUIRES_PURCHASE') });

await browser.close();
