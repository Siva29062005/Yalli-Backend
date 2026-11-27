// Checkout + payment regression (Chromium via Playwright). All API calls are intercepted in the browser and
// Razorpay's checkout.js is replaced by a stub, so no real payment provider is contacted.
// Usage (after `next build`):
//   API_INTERNAL_URL=http://127.0.0.1:4010/api/v1 npx next start -p 3101 &
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/test-checkout.mjs
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const BASE = process.env.FRONTEND_URL || 'http://localhost:3101';
const SHOTS = '/tmp/yalli-shots/checkout';
mkdirSync(SHOTS, { recursive: true });

const ORDER_ID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const ok = (data) => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data }) });
const fail = (status, message, code, details) => ({
  status, contentType: 'application/json', body: JSON.stringify({ success: false, message, error: { code, details } }),
});

const ADDRESS = {
  id: 'a0000000-0000-4000-8000-000000000001', label: 'Home', fullName: 'Priya R', phoneE164: '+919876543210',
  line1: '12 Lake Road', line2: null, landmark: null, city: 'Chennai', state: 'Tamil Nadu', postalCode: '600001', isDefault: true,
};

function fakeBackend(opts = {}) {
  const s = {
    calls: [], addresses: opts.addresses ?? [ADDRESS], cartItems: 1, priceChangedOnce: !!opts.priceChanged,
    shipping: opts.shipping ?? 'FREE', orderStatus: 'INVENTORY_RESERVED', confirmPaid: opts.confirmPaid ?? true,
    signedIn: opts.signedIn ?? true, cartFails: opts.cartFailsOnce ? 1 : 0, coupon: opts.coupon ? { code: 'WELCOME10', discountMinor: 9800 } : null,
    pollFails: opts.pollFailsOnce ? 1 : 0,
  };
  const totals = (ship = 0) => ({ subtotalMinor: 98000, discountMinor: 0, shippingMinor: ship, gstIncludedMinor: 14949, totalMinor: 98000 + ship, currency: 'INR' });
  const cart = () => ({
    items: s.cartItems ? [{
      variantId: 'v1', sku: 'SKU-1', productId: 'p1', productSlug: 'product-1', productName: 'Copper Bottle', variantName: '1 L',
      imageUrl: null, quantity: 2, unitPriceMinor: 49000, compareAtMinor: null, lineSubtotalMinor: 98000, lineDiscountMinor: 0,
      lineTotalMinor: 98000, purchasable: true, issue: null, maxQuantity: 5,
    }] : [],
    itemCount: s.cartItems ? 2 : 0, coupon: s.coupon, couponError: null, totals: s.cartItems ? totals() : { ...totals(), subtotalMinor: 0, totalMinor: 0, gstIncludedMinor: 0 },
  });
  const order = () => ({
    id: ORDER_ID, orderNumber: 'YL-260001', status: s.orderStatus, placedAt: '2026-11-19T10:00:00Z', paidAt: null,
    paymentExpiresAt: new Date(Date.now() + 29 * 60_000).toISOString(), cancellable: true, currency: 'INR',
    totals: { subtotalMinor: 98000, discountMinor: 0, shippingMinor: 0, gstIncludedMinor: 14949, totalMinor: 98000 }, couponCode: null,
    shippingAddress: { name: 'Priya R', phone: '+919876543210', line1: '12 Lake Road', line2: null, landmark: null, city: 'Chennai', state: 'Tamil Nadu', postalCode: '600001', country: 'IN' },
    shippingMethod: null,
    items: [{ id: 'oi1', sku: 'SKU-1', productName: 'Copper Bottle', variantName: '1 L', imageUrl: null, quantity: 2, unitPriceMinor: 49000, lineDiscountMinor: 0, lineTotalMinor: 98000 }],
  });
  async function handle(route) {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace('/api/v1', '');
    const body = req.postDataJSON?.() ?? null;
    s.calls.push({ path, method: req.method(), body, headers: req.headers() });
    if (path === '/catalog/categories') return route.fulfill(ok([]));
    if (path === '/auth/refresh') return route.fulfill(s.signedIn ? ok({ accessToken: 'at', csrfToken: 'csrf' }) : fail(401, 'No session', 'UNAUTHORIZED'));
    if (path === '/me') return route.fulfill(ok({ id: 'u1', email: 'priya@example.com', firstName: 'Priya', lastName: 'R', roles: ['CUSTOMER'] }));
    if (path === '/cart' && s.cartFails > 0) {
      s.cartFails -= 1;
      return route.fulfill(fail(503, 'Service unavailable', 'SERVICE_UNAVAILABLE'));
    }
    if (path === '/cart') return route.fulfill(ok(cart()));
    if (path === '/cart/coupon' && req.method() === 'DELETE') {
      s.coupon = null;
      return route.fulfill(ok(cart()));
    }
    if (path === '/me/addresses' && req.method() === 'GET') return route.fulfill(ok(s.addresses));
    if (path === '/me/addresses' && req.method() === 'POST') {
      if (body.postalCode === '000000') return route.fulfill(fail(400, 'Validation failed', 'VALIDATION_ERROR', [{ path: ['postalCode'], message: 'Enter a valid 6-digit PIN code' }]));
      const a = { ...ADDRESS, id: 'a0000000-0000-4000-8000-000000000002', fullName: body.fullName, line1: body.line1, city: body.city, state: body.state, postalCode: body.postalCode, phoneE164: '+91' + body.phone.replace(/\D/g, '').slice(-10), label: body.label ?? null, isDefault: !!body.isDefault };
      s.addresses.push(a);
      return route.fulfill(ok(a));
    }
    if (path === '/checkout/quote') {
      const multi = s.shipping === 'CHOICE';
      const options = multi ? [
        { code: 'STANDARD', name: 'Standard', feeMinor: 0, free: true, etaMinDays: 4, etaMaxDays: 6 },
        { code: 'EXPRESS', name: 'Express', feeMinor: 9900, free: false, etaMinDays: 1, etaMaxDays: 2 },
      ] : [];
      const code = body.shippingMethodCode ?? (multi ? 'STANDARD' : null);
      const fee = code === 'EXPRESS' ? 9900 : 0;
      const unserved = s.shipping === 'UNAVAILABLE';
      return route.fulfill(ok({
        purchasable: !unserved, problems: [], coupon: s.coupon, totals: totals(fee),
        minimumPayableMinor: 100, paymentWindowMinutes: opts.window ?? 30,
        shipping: unserved ? { status: 'UNAVAILABLE', selected: null, options: [] } : multi ? { status: 'SELECTED', selected: code, options } : { status: 'FREE', selected: null, options: [] },
        tax: { supply: 'INTRA_STATE', cgstMinor: 7474, sgstMinor: 7475, igstMinor: 0 },
      }));
    }
    if (path === '/checkout/orders') {
      if (s.priceChangedOnce) {
        s.priceChangedOnce = false;
        return route.fulfill(fail(409, 'The price changed since you last looked.', 'PRICE_CHANGED'));
      }
      s.cartItems = 0;
      return route.fulfill({ ...ok(order()), status: 201 });
    }
    if (path === `/orders/${ORDER_ID}/payments`) {
      if (opts.paymentsDown) return route.fulfill(fail(503, 'Online payment is temporarily unavailable', 'PAYMENT_PROVIDER_UNAVAILABLE'));
      return route.fulfill(ok({ keyId: 'rzp_test_abc', providerOrderId: 'order_ABC123', amountMinor: 98000, currency: 'INR', orderNumber: 'YL-260001', prefill: { email: 'priya@example.com' } }));
    }
    if (path === `/orders/${ORDER_ID}/payments/confirm`) {
      if (s.confirmPaid) s.orderStatus = 'PAID';
      return route.fulfill(ok({ status: s.orderStatus, paid: s.confirmPaid, order: { ...order(), paymentExpiresAt: null } }));
    }
    if (path === `/orders/${ORDER_ID}/cancel`) {
      s.orderStatus = 'CANCELLED';
      return route.fulfill(ok({ ...order(), cancellable: false, paymentExpiresAt: null }));
    }
    if (path === `/orders/${ORDER_ID}` && s.orderStatus === 'INVENTORY_RESERVED' && s.pollFails > 0 && s.calls.filter((c) => c.path === path).length > 1) {
      s.pollFails -= 1;
      return route.abort('failed'); // a network blip while polling
    }
    if (path === `/orders/${ORDER_ID}`) return route.fulfill(ok(order()));
    return route.fulfill(fail(404, 'Not found', 'NOT_FOUND'));
  }
  return { s, handle };
}

/** Stub of Razorpay checkout.js. `mode` decides what the "customer" does in the hosted window. */
const razorpayStub = (mode) => `
  window.__rzp = [];
  window.Razorpay = function (o) {
    window.__rzp.push(o);
    const handlers = {};
    return {
      on(e, cb) { handlers[e] = cb; },
      open() {
        setTimeout(() => {
          if (${JSON.stringify(mode)} === 'success') o.handler({ razorpay_order_id: o.order_id, razorpay_payment_id: 'pay_XYZ789', razorpay_signature: 'a'.repeat(64) });
          else if (${JSON.stringify(mode)} === 'fail') { handlers['payment.failed']?.({ error: { description: 'Card declined by bank' } }); o.modal.ondismiss(); }
          else o.modal.ondismiss();
        }, 50);
      },
    };
  };`;

const browser = await chromium.launch();
const test = async (name, fn, { viewport = { width: 1280, height: 900 }, backend = {}, rzp = 'success' } = {}) => {
  const context = await browser.newContext({ viewport });
  const be = fakeBackend(backend);
  if (be.s.signedIn) await context.addInitScript(() => sessionStorage.setItem('yalli_customer_csrf', 'csrf'));
  await context.route('**/api/v1/**', be.handle);
  await context.route('https://checkout.razorpay.com/**', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: razorpayStub(rzp) }));
  try {
    await fn(await context.newPage(), be);
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
const placeBtn = (page) => page.getByRole('button', { name: /Place order & pay/ });

await test('signed-out visitors are sent to login and back to checkout', async (page) => {
  await page.goto(`${BASE}/checkout`);
  await page.waitForURL(/\/auth\/login\?next=%2Fcheckout/);
}, { backend: { signedIn: false } });

await test('happy path: server quote → order with idempotency key → Razorpay → verified confirmation', async (page, be) => {
  await page.goto(`${BASE}/checkout`);
  await page.getByText('12 Lake Road', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Place order & pay ₹980' }).waitFor();
  await page.screenshot({ path: `${SHOTS}/checkout-desktop.png`, fullPage: true });
  await placeBtn(page).click();
  await page.waitForURL(new RegExp(`/orders/${ORDER_ID}/confirmation$`));
  await page.getByRole('heading', { name: 'Thank you! Your order is confirmed' }).waitFor();

  const place = be.s.calls.find((c) => c.path === '/checkout/orders');
  assert.deepEqual(place.body, { addressId: ADDRESS.id, expectedTotalMinor: 98000 });
  assert.match(place.headers['idempotency-key'], /^[0-9a-f-]{36}$/);
  const pay = be.s.calls.find((c) => c.path === `/orders/${ORDER_ID}/payments`);
  // A new key for every Pay click (a fixed per-order key replayed the first answer for 24 hours).
  assert.match(pay.headers['idempotency-key'], new RegExp(`^pay-${ORDER_ID}-[0-9a-f-]{36}$`));
  const confirm = be.s.calls.find((c) => c.path.endsWith('/payments/confirm'));
  assert.deepEqual(Object.keys(confirm.body).sort(), ['razorpay_order_id', 'razorpay_payment_id', 'razorpay_signature']);
  await page.screenshot({ path: `${SHOTS}/confirmation-paid.png`, fullPage: true });
});

await test('shipping choice re-quotes and updates the total', async (page, be) => {
  await page.goto(`${BASE}/checkout`);
  await page.getByText('Express').waitFor();
  await page.getByLabel(/Express/).check();
  await page.getByRole('button', { name: 'Place order & pay ₹1,079' }).waitFor();
  assert.ok(be.s.calls.some((c) => c.path === '/checkout/quote' && c.body.shippingMethodCode === 'EXPRESS'));
  await placeBtn(page).click();
  await page.waitForURL(/confirmation/);
  const place = be.s.calls.find((c) => c.path === '/checkout/orders');
  assert.equal(place.body.shippingMethodCode, 'EXPRESS');
  assert.equal(place.body.expectedTotalMinor, 107900);
}, { backend: { shipping: 'CHOICE' } });

await test('first-time buyer adds an address; server field errors are shown', async (page, be) => {
  await page.goto(`${BASE}/checkout`);
  await page.getByRole('form', { name: 'New address' }).waitFor();
  await page.getByRole('button', { name: 'Save and deliver here' }).click();
  await page.getByText('Enter a valid 10-digit mobile number').waitFor();
  await page.getByLabel('Full name').fill('Arun K');
  await page.getByLabel('Mobile number').fill('98765 43210');
  await page.getByLabel('House no., building, street').fill('4 Temple St');
  await page.getByLabel('City').fill('Madurai');
  await page.getByLabel('State').selectOption('Tamil Nadu');
  await page.getByLabel('PIN code').fill('625001');
  await page.getByRole('button', { name: 'Save and deliver here' }).click();
  await page.getByText('4 Temple St', { exact: false }).waitFor();
  const created = be.s.calls.find((c) => c.path === '/me/addresses' && c.method === 'POST');
  assert.equal(created.body.isDefault, true);
  assert.ok(!('line2' in created.body) || created.body.line2 === undefined);
  await placeBtn(page).waitFor();
  assert.ok(await placeBtn(page).isEnabled());
}, { backend: { addresses: [] } });

await test('price change on submit asks the customer to review, then succeeds', async (page) => {
  await page.goto(`${BASE}/checkout`);
  await placeBtn(page).click();
  await page.getByText(/Prices changed since you opened checkout/).waitFor();
  assert.ok(!page.url().includes('confirmation'));
  await placeBtn(page).click();
  await page.waitForURL(/confirmation/);
}, { backend: { priceChanged: true } });

await test('declined payment keeps the order; retry pay and cancel are offered', async (page, be) => {
  await page.goto(`${BASE}/checkout`);
  await placeBtn(page).click();
  await page.waitForURL(new RegExp(`/orders/${ORDER_ID}/confirmation`));
  await page.getByText('Card declined by bank').waitFor();
  await page.waitForFunction(() => !location.search.includes('payment='));
  assert.ok(!page.url().includes('payment='), 'the one-time ?payment= hint is removed from the address');
  await page.getByRole('heading', { name: 'Complete your payment' }).waitFor();
  await page.getByText(/left\)/).waitFor();
  await page.screenshot({ path: `${SHOTS}/confirmation-unpaid.png`, fullPage: true });
  // Paying again uses a NEW idempotency key, so the server re-checks the order instead of replaying the first attempt.
  await page.getByRole('button', { name: /^Pay ₹/ }).click();
  await page.getByText('Card declined by bank').waitFor();
  const keys = be.s.calls.filter((c) => c.path === `/orders/${ORDER_ID}/payments`).map((c) => c.headers['idempotency-key']);
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1]);
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Cancel order' }).click();
  await page.getByRole('heading', { name: 'Order cancelled' }).waitFor();
  assert.ok(be.s.calls.some((c) => c.path.endsWith('/cancel')));
}, { rzp: 'fail' });

await test('a cart that fails to load offers a retry instead of “Your cart is empty”', async (page) => {
  await page.goto(`${BASE}/checkout`);
  await page.getByRole('heading', { name: 'We couldn’t load your cart' }).waitFor();
  assert.equal(await page.getByText('Your cart is empty').count(), 0);
  await page.getByRole('button', { name: 'Try again' }).click();
  await placeBtn(page).waitFor();
}, { backend: { cartFailsOnce: true } });

await test('an address we do not deliver to says so (not “items unavailable”)', async (page) => {
  await page.goto(`${BASE}/checkout`);
  await page.getByText('We don’t deliver to this address yet').waitFor();
  assert.equal(await page.getByText('Some items are unavailable').count(), 0);
  assert.equal(await placeBtn(page).isDisabled(), true);
}, { backend: { shipping: 'UNAVAILABLE' } });

await test('the coupon can be removed at checkout, and the stock-hold note uses the server window', async (page, be) => {
  await page.goto(`${BASE}/checkout`);
  await page.getByText('held for 45 minutes').waitFor();
  await page.getByRole('button', { name: 'Remove coupon WELCOME10' }).click();
  await page.waitForFunction(() => !document.body.innerText.includes('Remove coupon WELCOME10'));
  assert.ok(be.s.calls.some((c) => c.path === '/cart/coupon' && c.method === 'DELETE'));
}, { backend: { coupon: true, window: 45 } });

await test('a network blip while confirming does not stop the check', async (page, be) => {
  await page.goto(`${BASE}/checkout`);
  await placeBtn(page).click();
  await page.getByRole('heading', { name: 'Confirming your payment…' }).waitFor();
  await page.waitForTimeout(4000); // one poll fails (aborted request)
  await page.getByRole('heading', { name: 'Confirming your payment…' }).waitFor();
  be.s.orderStatus = 'PAID'; // the webhook arrives
  await page.getByRole('heading', { name: 'Thank you! Your order is confirmed' }).waitFor({ timeout: 10_000 });
}, { backend: { confirmPaid: false, pollFailsOnce: true } });

await test('unverified success shows “confirming” and polls until the webhook marks it paid', async (page, be) => {
  await page.goto(`${BASE}/checkout`);
  await placeBtn(page).click();
  await page.getByRole('heading', { name: 'Confirming your payment…' }).waitFor();
  be.s.orderStatus = 'PAID';
  await page.getByRole('heading', { name: 'Thank you! Your order is confirmed' }).waitFor({ timeout: 10_000 });
}, { backend: { confirmPaid: false } });

await test('payments unavailable: order is kept and a clear message is shown', async (page) => {
  await page.goto(`${BASE}/checkout`);
  await placeBtn(page).click();
  await page.getByText(/Online payment is temporarily unavailable/).waitFor();
}, { backend: { paymentsDown: true } });

await test('invalid order id shows not-found without calling the API', async (page, be) => {
  await page.goto(`${BASE}/orders/not-a-uuid/confirmation`);
  await page.getByRole('heading', { name: 'Order not found' }).waitFor();
  assert.ok(!be.s.calls.some((c) => c.path.startsWith('/orders/')));
});

for (const width of [320, 375, 768, 1024, 1440]) {
  await test(`no horizontal overflow on checkout and confirmation at ${width}px`, async (page) => {
    await page.goto(`${BASE}/checkout`);
    await placeBtn(page).waitFor();
    await noOverflow(page);
    if (width === 375) await page.screenshot({ path: `${SHOTS}/checkout-mobile.png`, fullPage: true });
    await page.goto(`${BASE}/orders/${ORDER_ID}/confirmation`);
    await page.getByText('#YL-260001').waitFor();
    await noOverflow(page);
    if (width === 375) await page.screenshot({ path: `${SHOTS}/confirmation-mobile.png`, fullPage: true });
  }, { viewport: { width, height: 900 } });
}

await browser.close();
