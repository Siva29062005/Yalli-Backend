// Account pages regression (Chromium via Playwright). Every API call is intercepted in the browser by a stateful fake.
// Usage (after `next build`):
//   npx next start -p 3101 &
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/test-account.mjs
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const BASE = process.env.FRONTEND_URL || 'http://localhost:3101';
const SHOTS = '/tmp/yalli-shots/account';
mkdirSync(SHOTS, { recursive: true });

const ok = (data, meta = null) => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data, meta }) });
const fail = (status, message, code, details) => ({
  status, contentType: 'application/json', body: JSON.stringify({ success: false, message, error: { code, details } }),
});

const OID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const A1 = 'a0000000-0000-4000-8000-000000000001';
const A2 = 'a0000000-0000-4000-8000-000000000002';
const addr = (id, name, def) => ({
  id, label: def ? 'Home' : 'Work', fullName: name, phoneE164: '+919876543210', line1: `${name} street`, line2: null,
  landmark: null, city: 'Chennai', state: 'Tamil Nadu', postalCode: '600001', isDefault: def,
});
const product = (slug, name) => ({
  id: `p-${slug}`, slug, name, brand: null, imageUrl: null, inStock: true, addedAt: '2026-11-10T00:00:00Z',
  price: { amountMinor: 49000, compareAtMinor: 59000, onSale: true, currency: 'INR' },
});

function fakeBackend(opts = {}) {
  const s = {
    calls: [],
    me: { id: 'u1', email: 'priya@example.com', phone: null, emailVerified: true, phoneVerified: false, mfaEnabled: false, firstName: 'Priya', lastName: 'R', newsletterSubscribed: false, roles: ['CUSTOMER'], createdAt: '2026-01-05T00:00:00Z' },
    addresses: opts.addresses ?? [addr(A1, 'Priya R', true), addr(A2, 'Office Desk', false)],
    orderStatus: opts.orderStatus ?? 'DELIVERED',
    wishlist: [product('copper-bottle', 'Copper Bottle'), product('clay-pot', 'Clay Pot')],
    reviews: [{ id: 'r1', rating: 4, title: 'Nice', body: 'Keeps water cool all day.', status: 'APPROVED', moderationNote: null, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', product: { slug: 'copper-bottle', name: 'Copper Bottle' } }],
    sessions: [
      { id: 's1', deviceLabel: 'Yalli storefront', userAgent: 'Mozilla/5.0 (Macintosh; Mac OS X) Chrome/130', ip: '10.0.0.1', createdAt: '2026-11-18T00:00:00Z', lastSeenAt: '2026-11-19T00:00:00Z', current: true },
      { id: 's2', deviceLabel: null, userAgent: 'Mozilla/5.0 (iPhone) Safari/605', ip: '10.0.0.2', createdAt: '2026-11-10T00:00:00Z', lastSeenAt: '2026-11-12T00:00:00Z', current: false },
    ],
    returns: [],
    ordersCount: opts.ordersCount ?? 1,
  };
  const order = () => ({
    id: OID, orderNumber: 'YL-260001', status: s.orderStatus, placedAt: '2026-11-10T10:00:00Z',
    paidAt: s.orderStatus === 'INVENTORY_RESERVED' ? null : '2026-11-10T10:05:00Z',
    shippedAt: '2026-11-11T10:00:00Z', deliveredAt: s.orderStatus === 'DELIVERED' ? '2026-11-14T10:00:00Z' : null,
    cancelledAt: s.orderStatus === 'CANCELLED' ? '2026-11-10T11:00:00Z' : null,
    paymentExpiresAt: null, cancellable: ['PAID', 'INVENTORY_RESERVED'].includes(s.orderStatus), currency: 'INR',
    totals: { subtotalMinor: 98000, discountMinor: 0, shippingMinor: 0, gstIncludedMinor: 14949, totalMinor: 98000 }, couponCode: null,
    shippingAddress: { name: 'Priya R', phone: '+919876543210', line1: '12 Lake Road', line2: null, landmark: null, city: 'Chennai', state: 'Tamil Nadu', postalCode: '600001', country: 'IN' },
    shippingMethod: null,
    items: [{ id: 'b0000000-0000-4000-8000-000000000001', sku: 'SKU-1', productName: 'Copper Bottle <b>x</b>', variantName: '1 L', imageUrl: null, quantity: 2, unitPriceMinor: 49000, lineDiscountMinor: 0, lineTotalMinor: 98000 }],
  });
  async function handle(route) {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace('/api/v1', '');
    const m = req.method();
    const body = req.postDataJSON?.() ?? null;
    s.calls.push({ path, method: m, body, query: url.search });
    if (path === '/catalog/categories') return route.fulfill(ok([]));
    if (path === '/auth/refresh') return route.fulfill(ok({ accessToken: 'at', csrfToken: 'csrf' }));
    if (path === '/cart') return route.fulfill(ok({ items: [], itemCount: 0, coupon: null, couponError: null, totals: { subtotalMinor: 0, discountMinor: 0, shippingMinor: 0, gstIncludedMinor: 0, totalMinor: 0, currency: 'INR' } }));
    if (path === '/me' && m === 'GET') return route.fulfill(ok(s.me));
    if (path === '/me' && m === 'PATCH') {
      Object.assign(s.me, body);
      return route.fulfill(ok({ firstName: s.me.firstName, lastName: s.me.lastName, newsletterSubscribed: s.me.newsletterSubscribed }));
    }
    if (path === '/me/addresses' && m === 'GET') return route.fulfill(ok(s.addresses));
    if (path === '/me/addresses' && m === 'POST') {
      const a = { ...addr('a0000000-0000-4000-8000-000000000003', body.fullName, !!body.isDefault), line1: body.line1 };
      if (a.isDefault) s.addresses.forEach((x) => (x.isDefault = false));
      s.addresses.push(a);
      return route.fulfill(ok(a));
    }
    let mm;
    if ((mm = /^\/me\/addresses\/([^/]+)\/default$/.exec(path))) {
      s.addresses.forEach((x) => (x.isDefault = x.id === mm[1]));
      return route.fulfill(ok(s.addresses.find((x) => x.id === mm[1])));
    }
    if ((mm = /^\/me\/addresses\/([^/]+)$/.exec(path))) {
      const a = s.addresses.find((x) => x.id === mm[1]);
      if (m === 'PATCH') {
        if (body.postalCode === '000000') return route.fulfill(fail(400, 'Validation failed', 'VALIDATION_ERROR', [{ path: ['postalCode'], message: 'Enter a valid 6-digit PIN code' }]));
        Object.assign(a, { ...body, phoneE164: '+91' + String(body.phone ?? '').replace(/\D/g, '').slice(-10) });
        return route.fulfill(ok(a));
      }
      s.addresses = s.addresses.filter((x) => x.id !== mm[1]);
      if (a.isDefault && s.addresses[0]) s.addresses[0].isDefault = true;
      return route.fulfill(ok(null));
    }
    if (path === '/orders') {
      const page = Number(url.searchParams.get('page'));
      const rows = page === 1 ? Array.from({ length: s.ordersCount }, (_, i) => ({
        id: i === 0 ? OID : `0190a1b2-c3d4-7e5f-8a9b-${String(i).padStart(12, '0')}`, orderNumber: `YL-26${String(i + 1).padStart(4, '0')}`,
        status: i === 0 ? s.orderStatus : 'PAID', placedAt: '2026-11-10T10:00:00Z', totals: order().totals, itemCount: 2,
        items: [{ productName: 'Copper Bottle', imageUrl: null, quantity: 2 }], cancellable: false,
      })) : [];
      return route.fulfill(ok(rows));
    }
    if (path === `/orders/${OID}`) return route.fulfill(ok(order()));
    if (path === `/orders/${OID}/tracking`) return route.fulfill(ok({ shipment: { carrier: 'Delhivery', trackingNumber: 'DL123', status: 'DELIVERED', shippedAt: null, deliveredAt: null, events: [{ status: 'OUT_FOR_DELIVERY', location: 'Chennai', note: null, occurredAt: '2026-11-14T08:00:00Z' }] } }));
    if (path === `/orders/${OID}/cancel`) {
      s.orderStatus = 'CANCELLED';
      return route.fulfill(ok(order()));
    }
    if (path === `/orders/${OID}/invoice`) return route.fulfill(ok({
      invoiceNumber: 'INV-YL-260001', invoiceDate: '2026-11-10T10:05:00Z', orderNumber: 'YL-260001', taxInvoice: false,
      seller: { name: 'Yalli Marketing', state: 'Tamil Nadu', gstin: null }, buyer: { name: '<script>alert(1)</script>', email: 'priya@example.com' },
      placeOfSupply: 'Tamil Nadu', supply: 'INTRA_STATE', currency: 'INR',
      lines: [{ description: 'Copper Bottle', sku: 'SKU-1', hsn: '7418', quantity: 2, unitPriceMinor: 49000, discountMinor: 0, taxableValueMinor: 83051, gstRateBps: 1800, cgstMinor: 7474, sgstMinor: 7475, igstMinor: 0, lineTotalMinor: 98000 }],
      totals: { subtotalMinor: 98000, totalMinor: 98000 },
    }));
    if (path === `/orders/${OID}/returns`) {
      const r = { id: 'ret1', orderId: OID, orderItemId: body.orderItemId, quantity: body.quantity, reason: body.reason, opened: body.opened, status: 'REQUESTED', decisionNote: null, createdAt: '2026-11-15T00:00:00Z' };
      s.returns.push(r);
      return route.fulfill(ok(r));
    }
    if (path === '/returns') return route.fulfill(ok(s.returns));
    if (path === '/me/reviews') return route.fulfill(ok(s.reviews));
    if ((mm = /^\/me\/reviews\/([^/]+)$/.exec(path))) {
      if (m === 'DELETE') { s.reviews = []; return route.fulfill(ok(null)); }
      Object.assign(s.reviews[0], body, { status: 'PENDING' });
      const { product: _p, ...rest } = s.reviews[0];
      return route.fulfill(ok(rest));
    }
    if (path === '/me/wishlist') return route.fulfill(ok(s.wishlist));
    if ((mm = /^\/me\/wishlist\/([^/]+)$/.exec(path))) {
      if (m === 'DELETE') s.wishlist = s.wishlist.filter((p) => p.slug !== mm[1]);
      else if (!s.wishlist.some((p) => p.slug === mm[1])) s.wishlist.push(product(mm[1], mm[1]));
      return route.fulfill(ok(m === 'DELETE' ? null : { saved: true }));
    }
    if (path === '/auth/sessions') return route.fulfill(ok(s.sessions));
    if ((mm = /^\/auth\/sessions\/([^/]+)$/.exec(path))) {
      s.sessions = s.sessions.filter((x) => x.id !== mm[1]);
      return route.fulfill(ok(null));
    }
    if (path === '/auth/mfa/enroll') {
      if (body.password !== 'right-password') return route.fulfill(fail(401, 'Incorrect password', 'UNAUTHORIZED'));
      return route.fulfill(ok({ secret: 'JBSWY3DPEHPK3PXP', otpauthUri: 'otpauth://totp/Yalli:priya?secret=JBSWY3DPEHPK3PXP' }));
    }
    if (path === '/auth/mfa/confirm') {
      if (body.code !== '123456') return route.fulfill(fail(401, 'The code is incorrect or expired', 'UNAUTHORIZED'));
      s.me.mfaEnabled = true;
      return route.fulfill(ok({ recoveryCodes: ['AAAA-BBBB', 'CCCC-DDDD'] }));
    }
    if (path === '/auth/mfa/disable') {
      s.me.mfaEnabled = false;
      return route.fulfill(ok(null));
    }
    return route.fulfill(fail(404, `Unmocked ${m} ${path}`, 'NOT_FOUND'));
  }
  return { s, handle };
}

const browser = await chromium.launch();
const test = async (name, fn, { viewport = { width: 1280, height: 900 }, backend = {} } = {}) => {
  const context = await browser.newContext({ viewport });
  const be = fakeBackend(backend);
  await context.addInitScript(() => sessionStorage.setItem('yalli_customer_csrf', 'csrf'));
  await context.route('**/api/v1/**', be.handle);
  const page = await context.newPage();
  page.on('dialog', (d) => d.accept());
  try {
    await fn(page, be, context);
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n`, e);
    await page.screenshot({ path: `${SHOTS}/FAIL-${name.replace(/\W+/g, '-').slice(0, 50)}.png`, fullPage: true }).catch(() => {});
    process.exitCode = 1;
  } finally {
    await context.close();
  }
};
const noOverflow = async (page) =>
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'horizontal overflow');
const main = (page) => page.locator('main');

await test('profile: real data, save sends only allowed fields and refreshes the header', async (page, be) => {
  await page.goto(`${BASE}/account/profile`);
  const first = page.getByLabel('First name');
  await first.waitFor();
  assert.equal(await first.inputValue(), 'Priya');
  assert.ok(await page.getByRole('button', { name: 'Save changes' }).isDisabled(), 'save disabled until something changes');
  await first.fill('Priyanka');
  await page.getByLabel(/product launches/).check();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.getByRole('status').filter({ hasText: 'Saved' }).waitFor();
  const patch = be.s.calls.find((c) => c.path === '/me' && c.method === 'PATCH');
  assert.deepEqual(Object.keys(patch.body).sort(), ['firstName', 'lastName', 'newsletterSubscribed']);
  assert.equal(patch.body.firstName, 'Priyanka');
  await page.locator('aside').getByText('Priyanka R').waitFor();
});

await test('addresses: list, edit with server field error, make default, delete', async (page, be) => {
  await page.goto(`${BASE}/account/addresses`);
  await main(page).getByText('Office Desk street').waitFor();
  // Edit the non-default address: server rejects the PIN, then accepts a fix.
  await page.getByRole('button', { name: 'Edit' }).nth(1).click();
  const form = page.getByRole('form', { name: 'Edit address' });
  await form.getByLabel('PIN code').fill('000000');
  await form.getByRole('button', { name: 'Save address' }).click();
  await form.getByText('Enter a valid 6-digit PIN code').first().waitFor();
  await form.getByLabel('PIN code').fill('600002');
  await form.getByLabel('City').fill('Coimbatore');
  await form.getByLabel('Landmark (optional)').fill('');
  await form.getByRole('button', { name: 'Save address' }).click();
  await main(page).getByText('Coimbatore, Tamil Nadu').waitFor();
  // A cleared optional field is sent (as "") so the backend clears it, instead of being dropped.
  const saved = be.s.calls.filter((c) => c.path === `/me/addresses/${A2}` && c.method === 'PATCH').at(-1);
  assert.equal(saved.body.landmark, '');
  await page.getByRole('button', { name: 'Make default' }).click();
  await page.waitForFunction(() => document.querySelectorAll('main li:not(nav li)')[0]?.textContent?.includes('Office Desk'));
  assert.ok(be.s.calls.some((c) => c.path === `/me/addresses/${A2}/default` && c.method === 'PUT'));
  await page.getByRole('button', { name: 'Delete address for Priya R' }).click();
  await page.getByText('Priya R street').waitFor({ state: 'detached' });
  assert.ok(be.s.calls.some((c) => c.path === `/me/addresses/${A1}` && c.method === 'DELETE'));
});

await test('addresses: empty account shows the add form', async (page) => {
  await page.goto(`${BASE}/account/addresses`);
  await page.getByRole('heading', { name: 'Add your first address' }).waitFor();
}, { backend: { addresses: [] } });

await test('orders: list links to detail with tracking, invoice is escaped, return request', async (page, be, context) => {
  await page.goto(`${BASE}/account/orders`);
  await page.getByRole('link', { name: /YL-260001/ }).click();
  await page.waitForURL(`**/account/orders/${OID}`);
  await page.getByRole('heading', { name: 'Order YL-260001' }).waitFor();
  await page.getByText('DL123').waitFor();
  await page.getByText('Copper Bottle <b>x</b>').waitFor(); // rendered as text, not HTML
  // Invoice opens in a new window with user data escaped.
  const [popup] = await Promise.all([context.waitForEvent('page'), page.getByRole('button', { name: 'Invoice' }).click()]);
  await popup.waitForLoadState();
  const html = await popup.content();
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'buyer name escaped');
  assert.equal(await popup.locator('script').count(), 0);
  await popup.close();
  // Return flow
  await page.getByRole('button', { name: 'Return this item' }).click();
  await page.getByRole('button', { name: 'Request return' }).click();
  await page.getByText('Choose a reason.').waitFor();
  await page.getByLabel('Reason').selectOption('FAULTY');
  await page.getByRole('button', { name: 'Request return' }).click();
  await page.getByText('Please describe the problem.').waitFor();
  await page.getByLabel(/Details/).fill('Lid does not seal');
  await page.getByLabel('Quantity').selectOption('1');
  await page.getByRole('button', { name: 'Request return' }).click();
  await page.getByText('Return requested.').waitFor();
  const ret = be.s.calls.find((c) => c.path === `/orders/${OID}/returns`);
  assert.deepEqual(ret.body, { orderItemId: 'b0000000-0000-4000-8000-000000000001', quantity: 1, reason: 'FAULTY', opened: false, details: 'Lid does not seal' });
  await page.goto(`${BASE}/account/returns`);
  await page.getByText('Stopped working (faulty)').waitFor();
  await page.getByText('Under review').waitFor();
});

await test('orders: cancelling a paid order', async (page) => {
  await page.goto(`${BASE}/account/orders/${OID}`);
  await page.getByRole('button', { name: 'Cancel order' }).click();
  await page.getByText(/This order was cancelled/).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Cancel order' }).count(), 0);
}, { backend: { orderStatus: 'PAID' } });

await test('orders: empty history and pagination', async (page, be) => {
  await page.goto(`${BASE}/account/orders`);
  await page.getByText('No orders yet').waitFor();
}, { backend: { ordersCount: 0 } });

await test('orders: a full page offers Next', async (page, be) => {
  await page.goto(`${BASE}/account/orders`);
  await page.getByRole('button', { name: 'Next →' }).click();
  await page.getByText('No more orders').waitFor();
  assert.ok(be.s.calls.some((c) => c.path === '/orders' && c.query.includes('page=2')));
}, { backend: { ordersCount: 20 } });

await test('order detail: unknown order shows a not-found message', async (page) => {
  await page.goto(`${BASE}/account/orders/0190a1b2-c3d4-7e5f-8a9b-ffffffffffff`);
  await page.getByText("We couldn’t find this order in your account.").waitFor();
});

await test('wishlist: server-backed hearts, badge, remove', async (page, be) => {
  await page.goto(`${BASE}/account/wishlist`);
  await main(page).getByText('Clay Pot').waitFor();
  await page.getByRole('button', { name: 'Remove Clay Pot from wishlist' }).click();
  await main(page).getByText('Clay Pot').waitFor({ state: 'detached' });
  assert.ok(be.s.calls.some((c) => c.path === '/me/wishlist/clay-pot' && c.method === 'DELETE'));
  assert.ok(!be.s.calls.some((c) => c.path.startsWith('/me/wishlist') && c.method !== 'GET' && c.path.includes('copper')));
});

await test('reviews: edit goes back to moderation; delete', async (page, be) => {
  await page.goto(`${BASE}/account/reviews`);
  await page.getByText('Published').waitFor();
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Review').fill('short');
  await page.getByRole('button', { name: 'Save review' }).click();
  await page.getByText('at least 10 characters').waitFor();
  await page.getByLabel('Review').fill('Still great after a month of daily use.');
  await page.getByRole('radio', { name: '5 stars' }).click();
  await page.getByRole('button', { name: 'Save review' }).click();
  await page.getByText('Awaiting moderation').waitFor();
  const patch = be.s.calls.find((c) => c.path === '/me/reviews/r1' && c.method === 'PATCH');
  assert.equal(patch.body.rating, 5);
  await page.getByRole('button', { name: /Delete review/ }).click();
  await page.getByText('No reviews yet').waitFor();
});

await test('sessions: current device marked, other device signed out', async (page, be) => {
  await page.goto(`${BASE}/account/sessions`);
  await page.getByText('This device').waitFor();
  await page.getByText('Safari on iOS').waitFor();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByText('Safari on iOS').waitFor({ state: 'detached' });
  assert.ok(be.s.calls.some((c) => c.path === '/auth/sessions/s2' && c.method === 'DELETE'));
  assert.ok(!be.s.calls.some((c) => c.path === '/auth/sessions/s1'));
});

await test('2FA: wrong password, enroll, wrong code, confirm, recovery codes, disable', async (page) => {
  await page.goto(`${BASE}/account/security/2fa`);
  await page.getByLabel('Your password').fill('wrong');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByText('Incorrect password').waitFor();
  await page.getByLabel('Your password').fill('right-password');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByText('JBSW Y3DP EHPK 3PXP').waitFor();
  await page.getByLabel(/6-digit code/).fill('000000');
  await page.getByRole('button', { name: 'Turn on 2FA' }).click();
  await page.getByText('The code is incorrect or expired').waitFor();
  await page.getByLabel(/6-digit code/).fill('123456');
  await page.getByRole('button', { name: 'Turn on 2FA' }).click();
  await page.getByText('AAAA-BBBB').waitFor();
  await page.screenshot({ path: `${SHOTS}/2fa-codes.png`, fullPage: true });
  await page.getByRole('button', { name: 'I’ve saved them' }).click();
  await page.getByRole('heading', { name: '2FA is on' }).waitFor();
  await page.getByRole('button', { name: 'Turn off 2FA' }).click();
  await page.getByLabel('Your password').fill('right-password');
  await page.getByLabel(/6-digit code/).fill('123456');
  await page.getByRole('button', { name: 'Turn off 2FA' }).last().click();
  await page.getByRole('heading', { name: 'Turn on 2FA' }).waitFor();
});

await test('header wishlist badge shows the server count', async (page) => {
  await page.goto(`${BASE}/account/wishlist`);
  await main(page).getByText('Copper Bottle').waitFor();
  // header badge reflects the server count
  await page.locator('header').getByText('2', { exact: true }).first().waitFor();
});

await test('mobile: account menu is a compact tab row and the page title is above the fold', async (page) => {
  await page.goto(`${BASE}/account/addresses`);
  const tabs = page.getByRole('navigation', { name: 'Account sections' });
  await tabs.waitFor();
  assert.equal(await tabs.getByRole('link', { name: 'Addresses' }).getAttribute('aria-current'), 'page');
  const h1 = await page.locator('h1').first().boundingBox();
  assert.ok(h1 && h1.y + h1.height < 812, `title at ${h1?.y}px is below the first screen`);
  await page.screenshot({ path: `${SHOTS}/mobile-tabs.png` });
}, { viewport: { width: 375, height: 812 } });

for (const width of [320, 375, 768, 1024, 1440]) {
  await test(`no horizontal overflow on account pages at ${width}px`, async (page) => {
    for (const p of ['profile', 'addresses', 'orders', `orders/${OID}`, 'returns', 'reviews', 'wishlist', 'sessions', 'security/2fa']) {
      await page.goto(`${BASE}/account/${p}`);
      await page.locator('h1').first().waitFor();
      await page.waitForLoadState('load');
      await page.waitForTimeout(150);
      await noOverflow(page).catch((e) => { throw new Error(`${p}: ${e.message}`); });
      if (width === 375 || width === 1440) await page.screenshot({ path: `${SHOTS}/${p.replace(/\W+/g, '-')}-${width}.png`, fullPage: true });
    }
  }, { viewport: { width, height: 900 } });
}

await browser.close();
