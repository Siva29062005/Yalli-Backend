// Server-backed cart regression + screenshots (Chromium via Playwright).
// Product pages come from the mock API server (see test-catalog.mjs); /cart calls are intercepted in the browser.
// Usage:
//   node scripts/test-catalog.mjs --mock-api 4010 &
//   API_INTERNAL_URL=http://127.0.0.1:4010/api/v1 npx next start -p 3101 &
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/test-cart.mjs
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const BASE = process.env.FRONTEND_URL || 'http://localhost:3101';
const SHOTS = '/tmp/yalli-shots/cart';
mkdirSync(SHOTS, { recursive: true });

const GUEST_TOKEN = 'g'.repeat(43);
const ok = (data) => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data }) });
const fail = (status, message, code) => ({
  status, contentType: 'application/json', body: JSON.stringify({ success: false, message, error: { code } }),
});

/** Minimal stateful fake of the backend cart: prices are owned by the "server". */
function fakeBackend({ stock = 5, signedIn = false } = {}) {
  const carts = { guest: null, user: [] };
  const state = { signedIn, calls: [], coupon: null, stock, unavailable: false };
  const line = (variantId, quantity) => {
    const unit = 49000;
    const issue = state.unavailable ? 'UNAVAILABLE' : quantity > state.stock ? 'INSUFFICIENT_STOCK' : null;
    return {
      variantId, sku: `SKU-${variantId}`, productId: 'p1', productSlug: 'product-1', productName: 'Product 1',
      variantName: '500 ml', imageUrl: null, quantity, unitPriceMinor: unit, compareAtMinor: 79900,
      lineSubtotalMinor: unit * quantity, lineDiscountMinor: 0, lineTotalMinor: unit * quantity,
      purchasable: issue === null, issue, maxQuantity: Math.min(10, state.stock),
    };
  };
  const view = (items, extra = {}) => {
    const lines = items.map((i) => line(i.variantId, i.quantity));
    const sub = lines.filter((l) => l.purchasable).reduce((n, l) => n + l.lineSubtotalMinor, 0);
    const disc = state.coupon ? 10000 : 0;
    return {
      ...extra, items: lines, itemCount: lines.filter((l) => l.purchasable).reduce((n, l) => n + l.quantity, 0),
      coupon: state.coupon ? { code: state.coupon, discountMinor: disc } : null, couponError: null,
      totals: { subtotalMinor: sub, discountMinor: disc, shippingMinor: 0, gstIncludedMinor: Math.round(((sub - disc) * 18) / 118), totalMinor: sub - disc, currency: 'INR' },
    };
  };
  async function handle(route) {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace('/api/v1', '');
    const h = req.headers();
    const body = req.postDataJSON?.() ?? null;
    state.calls.push({ path, method: req.method(), body, headers: h });
    if (path === '/catalog/categories') return route.fulfill(ok([]));
    if (path === '/auth/refresh') return route.fulfill(state.signedIn ? ok({ accessToken: 'at', csrfToken: 'csrf' }) : fail(401, 'No session', 'UNAUTHORIZED'));
    if (path === '/me') return route.fulfill(ok({ id: 'u1', email: 'a@b.co', firstName: 'Priya', lastName: null, roles: ['CUSTOMER'] }));
    if (!path.startsWith('/cart')) return route.fulfill(ok(null));

    const user = !!h.authorization;
    if (path === '/cart/merge') {
      if (!user) return route.fulfill(fail(401, 'Unauthorized', 'UNAUTHORIZED'));
      for (const g of carts.guest ?? []) {
        const e = carts.user.find((i) => i.variantId === g.variantId);
        if (e) e.quantity = Math.min(e.quantity + g.quantity, state.stock);
        else carts.user.push({ ...g });
      }
      carts.guest = null;
      return route.fulfill(ok(view(carts.user)));
    }
    let items;
    let issued;
    if (user) items = carts.user;
    else if (h['x-cart-token'] === GUEST_TOKEN && carts.guest) items = carts.guest;
    else if (path === '/cart/items' && req.method() === 'POST') {
      carts.guest = items = [];
      issued = GUEST_TOKEN;
    } else if (req.method() === 'GET') return route.fulfill(ok(view([])));
    else return route.fulfill(fail(404, 'Your cart is empty', 'NOT_FOUND'));

    if (path === '/cart/items' && req.method() === 'POST') {
      const e = items.find((i) => i.variantId === body.variantId);
      const next = (e?.quantity ?? 0) + body.quantity;
      if (next > state.stock) return route.fulfill(fail(409, `Only ${state.stock} available`, 'INSUFFICIENT_STOCK'));
      if (e) e.quantity = next;
      else items.push({ variantId: body.variantId, quantity: body.quantity });
    } else if (path.startsWith('/cart/items/') && req.method() === 'PATCH') {
      const id = path.split('/').pop();
      if (body.quantity > state.stock) return route.fulfill(fail(409, `Only ${state.stock} available`, 'INSUFFICIENT_STOCK'));
      items.find((i) => i.variantId === id).quantity = body.quantity;
    } else if (path.startsWith('/cart/items/') && req.method() === 'DELETE') {
      const id = path.split('/').pop();
      items.splice(items.findIndex((i) => i.variantId === id), 1);
    } else if (path === '/cart/coupon' && req.method() === 'POST') {
      if (body.code.toUpperCase() !== 'WELCOME100') return route.fulfill(fail(400, 'This coupon code is not valid', 'COUPON_INVALID'));
      state.coupon = 'WELCOME100';
    } else if (path === '/cart/coupon' && req.method() === 'DELETE') state.coupon = null;
    return route.fulfill(ok(view(items, issued ? { cartToken: issued } : {})));
  }
  return { state, carts, handle };
}

const browser = await chromium.launch();
const test = async (name, fn, viewport = { width: 1280, height: 900 }) => {
  const context = await browser.newContext({ viewport });
  try {
    await fn(context);
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n`, e);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
};
const noOverflow = async (page) =>
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'horizontal overflow');
const cartButton = (page) => page.locator('header button[title="Shopping Cart"]');

await test('guest add-to-cart gets a server token, persists across reload, and renders server totals', async (context) => {
  const be = fakeBackend();
  await context.route('**/api/v1/**', be.handle);
  const page = await context.newPage();
  await page.goto(`${BASE}/products/product-1`);
  await page.getByRole('button', { name: 'Add to Cart' }).click();
  await page.getByRole('dialog', { name: 'Your cart' }).waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem('yalli_cart_token')), GUEST_TOKEN);
  const add = be.state.calls.find((c) => c.path === '/cart/items');
  assert.deepEqual(add.body, { variantId: 'v1', quantity: 1 });
  assert.ok(!('priceMinor' in add.body), 'client must not send prices');
  await page.screenshot({ path: `${SHOTS}/drawer-desktop.png` });

  await page.goto(`${BASE}/cart`);
  await page.getByText('Product 1').first().waitFor();
  assert.equal(await cartButton(page).getAttribute('aria-label'), 'Cart, 1 items');
  assert.ok(be.state.calls.some((c) => c.path === '/cart' && c.headers['x-cart-token'] === GUEST_TOKEN));
  await page.getByText('₹490').first().waitFor();
});

await test('quantity limits and stock errors come from the server', async (context) => {
  const be = fakeBackend({ stock: 2 });
  await context.route('**/api/v1/**', be.handle);
  const page = await context.newPage();
  await page.goto(`${BASE}/products/product-1`);
  await page.getByRole('button', { name: 'Add to Cart' }).click();
  await page.getByRole('dialog', { name: 'Your cart' }).waitFor();
  await page.goto(`${BASE}/cart`);
  const inc = page.getByRole('button', { name: 'Increase quantity of Product 1' });
  await inc.click();
  await page.locator('main').getByText('₹980').first().waitFor();
  assert.ok(await inc.isDisabled(), 'stepper capped at server maxQuantity');

  be.state.stock = 1; // stock dropped elsewhere
  await page.reload();
  await page.getByText(/Only 1 left/).waitFor();
  await page.getByText('Remove or update unavailable items to checkout').waitFor();
  assert.equal(await page.getByRole('link', { name: /Proceed to Checkout/ }).count(), 0);
  await page.screenshot({ path: `${SHOTS}/cart-stock-issue.png`, fullPage: true });

  // "−" on a line over stock steps straight down to what is available (2 -> 1), not to an impossible 1 below the old value
  await page.getByRole('button', { name: 'Decrease quantity of Product 1' }).click();
  await page.getByText(/Only 1 left/).waitFor({ state: 'detached' });
});

await test('one cart drawer for every page: the header cart button works on the account pages too', async (context) => {
  const be = fakeBackend({ stock: 5 });
  await context.route('**/api/v1/**', be.handle);
  const page = await context.newPage();
  await page.goto(`${BASE}/products/product-1`);
  await page.getByRole('button', { name: 'Add to Cart' }).click();
  await page.getByRole('dialog', { name: 'Your cart' }).waitFor();
  await page.keyboard.press('Escape');
  await page.goto(`${BASE}/help`);
  await page.locator('header').getByRole('button', { name: /cart/i }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Your cart' });
  await dialog.waitFor();
  assert.equal(await page.getByRole('dialog', { name: 'Your cart' }).count(), 1, 'exactly one drawer');
  // header badge, drawer title and cart page count the same units
  assert.match(await dialog.getByRole('heading').first().innerText(), /\(1\)/);
  await dialog.getByRole('link', { name: 'View full cart' }).click();
  await page.waitForURL(/\/cart/);
  assert.equal(await page.getByRole('dialog', { name: 'Your cart' }).count(), 0, 'navigating closes the drawer');
});

await test('add beyond stock shows the server error on the product page', async (context) => {
  const be = fakeBackend({ stock: 1 });
  await context.route('**/api/v1/**', be.handle);
  const page = await context.newPage();
  await page.goto(`${BASE}/products/product-1`);
  await page.getByRole('button', { name: 'Increase quantity' }).click();
  await page.getByRole('button', { name: 'Add to Cart' }).click();
  await page.getByRole('alert').filter({ hasText: 'Only 1 available' }).waitFor();
});

await test('coupons are validated by the server', async (context) => {
  const be = fakeBackend();
  await context.route('**/api/v1/**', be.handle);
  const page = await context.newPage();
  await page.goto(`${BASE}/products/product-1`);
  await page.getByRole('button', { name: 'Add to Cart' }).click();
  await page.getByRole('dialog', { name: 'Your cart' }).waitFor();
  await page.goto(`${BASE}/cart`);
  await page.getByLabel('Have a coupon?').fill('JOY20');
  await page.getByRole('button', { name: 'Apply' }).click();
  await page.getByText('This coupon code is not valid').waitFor();
  await page.getByLabel('Have a coupon?').fill('welcome100');
  await page.getByRole('button', { name: 'Apply' }).click();
  await page.getByText('WELCOME100 applied').waitFor();
  await page.getByText('₹390').first().waitFor();
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await page.getByLabel('Have a coupon?').waitFor();
});

await test('removing the last item shows the empty state', async (context) => {
  const be = fakeBackend();
  await context.route('**/api/v1/**', be.handle);
  const page = await context.newPage();
  await page.goto(`${BASE}/products/product-1`);
  await page.getByRole('button', { name: 'Add to Cart' }).click();
  await page.getByRole('dialog', { name: 'Your cart' }).waitFor();
  await page.goto(`${BASE}/cart`);
  await page.getByRole('button', { name: /Remove ✕/ }).click();
  await page.getByText('Your cart is taking a breather.').waitFor();
});

await test('guest cart merges into the account on sign-in and the guest token is dropped', async (context) => {
  const be = fakeBackend();
  be.carts.user.push({ variantId: 'v1', quantity: 1 });
  await context.route('**/api/v1/**', be.handle);
  const page = await context.newPage();
  await page.goto(`${BASE}/products/product-1`);
  await page.getByRole('button', { name: 'Add to Cart' }).click();
  await page.getByRole('dialog', { name: 'Your cart' }).waitFor();
  // Simulate a completed sign-in (cookie session + CSRF token), then reload.
  be.state.signedIn = true;
  await page.evaluate(() => sessionStorage.setItem('yalli_customer_csrf', 'csrf'));
  await page.goto(`${BASE}/cart`);
  await page.getByText('Product 1').first().waitFor();
  const merge = be.state.calls.find((c) => c.path === '/cart/merge');
  assert.ok(merge, 'merge called');
  assert.equal(merge.headers['x-cart-token'], GUEST_TOKEN);
  assert.equal(await page.evaluate(() => localStorage.getItem('yalli_cart_token')), null);
  await page.locator('main').getByText('2 items').waitFor();
});

await test('old browser-only demo cart is discarded', async (context) => {
  const be = fakeBackend();
  await context.route('**/api/v1/**', be.handle);
  await context.addInitScript(() => {
    if (!localStorage.getItem('seeded')) {
      localStorage.setItem('seeded', '1');
      localStorage.setItem('yalli-storefront-v1', JSON.stringify({ state: { cart: [{ variantId: 'var-st-20', quantity: 1 }], wishlistSlugs: [] }, version: 2 }));
    }
  });
  const page = await context.newPage();
  await page.goto(`${BASE}/cart`);
  await page.getByText('Your cart is taking a breather.').waitFor();
  const saved = JSON.parse(await page.evaluate(() => localStorage.getItem('yalli-storefront-v1')));
  assert.equal(saved.state.cart, undefined);
});

for (const width of [320, 375, 768, 1024, 1440]) {
  await test(`no horizontal overflow on cart at ${width}px`, async (context) => {
    const be = fakeBackend();
    await context.route('**/api/v1/**', be.handle);
    const page = await context.newPage();
    await page.goto(`${BASE}/products/product-1`);
    await page.getByRole('button', { name: 'Add to Cart' }).click();
    await page.getByRole('dialog', { name: 'Your cart' }).waitFor();
    await page.goto(`${BASE}/cart`);
    await page.getByText('Product 1').first().waitFor();
    await noOverflow(page);
    if (width === 375) await page.screenshot({ path: `${SHOTS}/cart-mobile.png`, fullPage: true });
    if (width === 1440) await page.screenshot({ path: `${SHOTS}/cart-desktop.png`, fullPage: true });
  }, { width, height: 900 });
}

await browser.close();
