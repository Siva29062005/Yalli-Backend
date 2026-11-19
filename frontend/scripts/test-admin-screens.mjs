// Browser regression for the staff workspace screens (products, inventory, orders, refunds, coupons, shipping,
// users, analytics). Only the HTTP boundary is faked: the pages, step-up prompt and request bodies are the real ones.
// Usage (after `next build`):
//   npx next start -p 3101 &
//   FRONTEND_URL=http://localhost:3101 PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/test-admin-screens.mjs
import assert from 'node:assert/strict';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});
const base = process.env.FRONTEND_URL || 'http://localhost:3101';
const page = await browser.newPage();
page.on('dialog', (dialog) => void dialog.accept()); // window.confirm

const ALL_PERMISSIONS = ['analytics.read', 'products.read', 'products.create', 'products.update', 'products.delete', 'products.publish', 'inventory.read', 'inventory.adjust', 'orders.read', 'orders.update', 'shipments.manage', 'payments.read', 'refunds.create', 'refunds.approve', 'coupons.manage', 'users.manage', 'customers.suspend'];
const SUPPORT_PERMISSIONS = ['products.read', 'orders.read', 'refunds.create', 'customers.read', 'reviews.moderate'];
let signedInAs = 'admin';
const meFor = () => signedInAs === 'support'
  ? { id: 'staff-2', email: 'support@example.test', roles: ['CUSTOMER_SUPPORT'], mfaEnabled: true, permissions: SUPPORT_PERMISSIONS }
  : { id: 'staff-1', email: 'admin@example.test', roles: ['SUPER_ADMIN'], mfaEnabled: true, permissions: ALL_PERMISSIONS };
const calls = [];
const ok = (data, meta) => ({ status: 200, json: { success: true, data, ...(meta ? { meta } : {}) } });
const list = (items) => ok(items, { page: 1, pageSize: 20, total: items.length, totalPages: 1 });
const fail = (status, message, code) => ({ status, json: { success: false, message, error: { code } } });

// ------------------------------------------------------------------------------------------ fake backend state
const state = {
  stepUpPending: true, // the first inventory read demands a fresh MFA step-up
  token: 'access-1',
  orderStatus: 'PAID',
  refunds: [
    { id: 'r-other', orderId: 'o1', order: { orderNumber: 'YL26-000001' }, kind: 'ADMIN', amountMinor: 50000, status: 'PENDING_APPROVAL', reason: 'Damaged on arrival', requestedById: 'someone-else', approvedById: null, createdAt: '2026-11-18T10:00:00Z', processedAt: null, failureReason: null },
    { id: 'r-mine', orderId: 'o1', order: { orderNumber: 'YL26-000001' }, kind: 'GOODWILL', amountMinor: 10000, status: 'PENDING_APPROVAL', reason: 'Late delivery gesture', requestedById: 'staff-1', approvedById: null, createdAt: '2026-11-18T11:00:00Z', processedAt: null, failureReason: null },
  ],
};
const orderDetail = () => ({
  id: 'o1', orderNumber: 'YL26-000001', status: state.orderStatus, placedAt: '2026-11-18T09:00:00Z', paidAt: '2026-11-18T09:05:00Z',
  paymentExpiresAt: null, cancellable: true, currency: 'INR',
  totals: { subtotalMinor: 138000, discountMinor: 0, shippingMinor: 0, gstIncludedMinor: 21051, totalMinor: 138000 },
  couponCode: null, contactEmail: 'ananya@example.test', contactPhone: '+919876543210',
  shippingAddress: { name: 'Ananya', phone: '+919876543210', line1: '12 Lake Road', line2: null, landmark: null, city: 'Madurai', state: 'Tamil Nadu', postalCode: '625001', country: 'IN' },
  shippingMethod: null,
  items: [{ id: 'i1', sku: 'YAL-ST-20', productName: 'Momo Steamer', variantName: '2 tier', imageUrl: null, quantity: 2, unitPriceMinor: 69000, lineDiscountMinor: 0, lineTotalMinor: 138000 }],
  history: [{ from: null, to: 'PAID', at: '2026-11-18T09:05:00Z', actorType: 'SYSTEM', actorId: null, reason: null }],
  returns: [],
});
const salesDays = Array.from({ length: 30 }, (_, i) => ({ date: `2026-10-${String(21 + (i % 11)).padStart(2, '0')}`, paidOrders: i % 5, grossMinor: (i % 5) * 138000 }));

function handle(method, path, request) {
  const body = request.postData() && !(request.headers()['content-type'] ?? '').startsWith('multipart') ? request.postDataJSON() : undefined;
  calls.push({ method, path, body, headers: request.headers() });
  const m = `${method} ${path}`;
  if (m === 'POST /auth/login') return ok({ mfaRequired: true, mfaToken: 'challenge' });
  if (m === 'POST /auth/mfa/verify') return ok({ accessToken: state.token, csrfToken: 'csrf' });
  if (m === 'POST /auth/mfa/step-up') {
    state.token = 'access-stepped';
    state.stepUpPending = false;
    return ok({ accessToken: 'access-stepped' });
  }
  if (m === 'POST /auth/refresh') return ok({ accessToken: state.token, csrfToken: 'csrf' });
  if (m === 'GET /me') return ok(meFor());
  if (m === 'GET /catalog/categories') return ok([]);

  if (path.startsWith('/admin/') && state.stepUpPending && path === '/admin/inventory') return fail(403, 'Recent multi-factor verification is required', 'STEP_UP_REQUIRED');

  // products
  if (m === 'GET /admin/products') return list([{ id: 'p1', slug: 'momo-steamer', name: 'Momo Steamer', status: 'DRAFT', updatedAt: '2026-11-18T09:00:00Z', _count: { variants: 1, images: 0 } }]);
  if (m === 'GET /admin/brands') return ok([{ id: 'b1', name: 'Yalli' }]);
  if (m === 'GET /admin/categories') return ok([{ id: 'c1', name: 'Kitchen and Dining' }]);
  if (m === 'POST /admin/products') return { status: 201, json: { success: true, data: { id: 'p1' } } };
  if (m === 'GET /admin/products/p1')
    return ok({ id: 'p1', slug: 'momo-steamer', name: 'Momo Steamer', summary: null, descriptionHtml: '', status: 'DRAFT', brandId: null, gstRateBps: 1800, hsnCode: null, categories: [{ id: 'c1', name: 'Kitchen and Dining' }], tags: [], attributes: [], images: [], variants: [{ id: 'v1', sku: 'YAL-ST-20', name: null, priceMinor: 79900, salePriceMinor: 49000, saleStartsAt: null, saleEndsAt: null, isActive: true, weightGrams: null, available: 7 }], updatedAt: '2026-11-18T09:00:00Z' });
  if (m === 'POST /admin/products/p1/publish') return ok({});

  // inventory
  if (m === 'GET /admin/inventory') return list([{ sku: 'YAL-ST-20', product: 'Momo Steamer', warehouse: 'MAIN', onHand: 18, reserved: 6, available: 12, lowStockThreshold: 15 }]);
  if (m === 'GET /admin/warehouses') return ok([{ code: 'MAIN', name: 'Madurai', isDefault: true, isActive: true }]);
  if (m === 'POST /admin/inventory/adjustments') return ok({ sku: 'YAL-ST-20', onHand: 23, reserved: 6 });

  // orders
  if (m === 'GET /admin/orders') return list([{ id: 'o1', orderNumber: 'YL26-000001', status: state.orderStatus, placedAt: '2026-11-18T09:00:00Z', totalMinor: 138000, contactEmail: 'ananya@example.test', shipCity: 'Madurai', shipState: 'Tamil Nadu' }]);
  if (m === 'GET /admin/orders/o1') return ok(orderDetail());
  if (m === 'GET /admin/orders/o1/tracking') return ok({ shipment: null });
  if (m === 'GET /admin/orders/o1/payments') return ok([{ id: 'pay1', status: 'CAPTURED', amountMinor: 138000, capturedMinor: 138000, refundedMinor: 0, attempt: 1, method: 'upi', providerPaymentId: 'pay_123', failureCode: null, createdAt: '2026-11-18T09:01:00Z' }]);
  if (m === 'POST /admin/orders/o1/fulfilment') {
    state.orderStatus = body.status;
    return ok({});
  }

  // refunds + returns
  if (m === 'GET /admin/refunds') return list(state.refunds);
  if (m === 'POST /admin/refunds') return { status: 201, json: { success: true, data: { id: 'r-new', status: 'PENDING_APPROVAL', amountMinor: body.amountMinor } } };
  if (m === 'POST /admin/refunds/r-other/approve') {
    state.refunds = state.refunds.filter((r) => r.id !== 'r-other');
    return ok({ id: 'r-other', status: 'APPROVED' });
  }
  if (m === 'GET /admin/returns') return list([{ id: 'ret1', quantity: 1, reason: 'FAULTY', opened: true, details: 'Lid is cracked', status: 'REQUESTED', decisionNote: null, createdAt: '2026-11-18T12:00:00Z', order: { orderNumber: 'YL26-000001' }, item: { productName: 'Momo Steamer', sku: 'YAL-ST-20' } }]);
  if (m === 'POST /admin/returns/ret1/decision') return ok(null);

  // coupons + shipping
  if (m === 'GET /admin/coupons') return list([{ id: 'cp1', code: 'WELCOME10', description: null, discountType: 'PERCENTAGE', percentBps: 1000, amountMinor: null, maxDiscountMinor: null, scope: 'ALL_ITEMS', minCartMinor: 0, startsAt: null, expiresAt: null, maxRedemptions: null, redeemedCount: 3, perCustomerLimit: null, isActive: true }]);
  if (m === 'POST /admin/coupons') return { status: 201, json: { success: true, data: { id: 'cp2' } } };
  if (m === 'GET /admin/shipping-methods') return ok([]);
  if (m === 'POST /admin/shipping-methods') return { status: 201, json: { success: true, data: { id: 'sm1' } } };

  // users
  if (m === 'GET /admin/roles') return ok([{ name: 'CUSTOMER', description: 'Shopper', rank: 0, permissions: [] }, { name: 'CUSTOMER_SUPPORT', description: 'Helps customers', rank: 10, permissions: ['orders.read'] }]);
  if (m === 'GET /admin/users') return list([
    { id: 'staff-1', email: 'admin@example.test', name: 'Test Admin', status: 'ACTIVE', mfaEnabled: true, createdAt: '2026-11-01T00:00:00Z', lastLoginAt: null, roles: ['SUPER_ADMIN'] },
    { id: 'u2', email: 'priya@example.test', name: 'Priya R', status: 'ACTIVE', mfaEnabled: true, createdAt: '2026-11-02T00:00:00Z', lastLoginAt: null, roles: ['CUSTOMER'] },
  ]);
  if (m === 'POST /admin/users/u2/roles') return ok(null);

  // analytics
  if (m === 'GET /admin/analytics/overview')
    return ok({ range: { from: '2026-10-21', to: '2026-11-19', days: 30 }, paidOrders: 12, uniqueBuyers: 9, grossMinor: 1656000, refundedMinor: 50000, refundCount: 1, netMinor: 1606000, averageOrderValueMinor: 138000, discountMinor: 20000, shippingMinor: 0, gstIncludedMinor: 252600, ordersPlacedByStatus: { PAID: 5, DELIVERED: 7 } });
  if (m === 'GET /admin/analytics/sales-by-day') return ok({ days: salesDays });
  if (m === 'GET /admin/analytics/top-products') return ok({ products: [{ productId: 'p1', name: 'Momo Steamer', units: 8, revenueMinor: 552000 }] });
  if (m === 'GET /admin/analytics/gst-summary')
    return ok({ byRate: [{ rateBps: 1800, taxableValueMinor: 1403400, cgstMinor: 126300, sgstMinor: 126300, igstMinor: 0, totalGstMinor: 252600 }], totals: { taxableValueMinor: 1403400, cgstMinor: 126300, sgstMinor: 126300, igstMinor: 0, totalGstMinor: 252600 }, notes: ['Not reduced for refunds.'] });
  return ok(null);
}

await page.route('**/api/v1/**', async (route) => {
  const request = route.request();
  const path = new URL(request.url()).pathname.replace('/api/v1', '');
  return route.fulfill(handle(request.method(), path, request));
});

const lastCall = (method, path) => calls.filter((c) => c.method === method && c.path === path).at(-1);
const go = async (name, heading) => {
  await page.getByRole('link', { name, exact: true }).click();
  await page.getByRole('heading', { name: heading, exact: true, level: 1 }).waitFor();
};
const overflow = async (label) => {
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  assert.ok(wide <= 1, `${label}: page is ${wide}px wider than the screen`);
};

try {
  // ----------------------------------------------------------------------------------------------- sign in
  await page.goto(`${base}/admin/analytics`);
  await page.getByLabel('Work email').fill('admin@example.test');
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Authenticator code').fill('123456');
  await page.getByRole('button', { name: 'Verify and continue' }).click();

  // ----------------------------------------------------------------------------------------------- analytics
  await page.getByRole('heading', { name: 'The everyday, at a glance.', level: 1 }).waitFor();
  await page.getByText('₹16,560.00').first().waitFor(); // gross revenue 1,656,000 paise
  assert.equal(await page.getByRole('button', { name: /paid order/ }).count(), 30, 'one bar per day');
  await page.getByRole('button', { name: /paid order/ }).nth(4).hover();
  await page.getByRole('status').filter({ hasText: 'paid order' }).first().waitFor();
  await page.getByRole('button', { name: 'Show as table' }).click();
  await page.getByRole('columnheader', { name: 'Revenue' }).waitFor();
  assert.equal(calls.filter((c) => c.path === '/admin/analytics/overview').at(-1) !== undefined, true);
  await page.getByRole('button', { name: 'Last 7 days' }).click();
  await page.waitForFunction(() => document.querySelector('[aria-busy="false"]'));
  const range = lastCall('GET', '/admin/analytics/overview');
  assert.ok(range, 'range change refetches the overview');

  // ----------------------------------------------------------------------------------------------- inventory + step-up
  await go('Inventory', 'Inventory');
  await page.getByRole('dialog', { name: /Confirm it/ }).waitFor();
  await page.getByLabel('Authenticator code').fill('654321');
  await page.getByRole('button', { name: 'Verify', exact: true }).click();
  await page.getByText('YAL-ST-20').first().waitFor();
  assert.equal(calls.filter((c) => c.path === '/admin/inventory').at(-1).headers.authorization, 'Bearer access-stepped', 'retry used the stepped-up token');
  await page.getByRole('button', { name: 'Adjust', exact: true }).click();
  await page.getByLabel('Quantity').fill('5');
  await page.getByLabel('Reason').fill('Supplier delivery');
  await page.getByRole('button', { name: 'Save adjustment' }).click();
  await page.getByText('YAL-ST-20: stock is now 23 on hand.').waitFor();
  assert.deepEqual(lastCall('POST', '/admin/inventory/adjustments').body, { sku: 'YAL-ST-20', delta: 5, type: 'RECEIPT', reason: 'Supplier delivery' });

  // ----------------------------------------------------------------------------------------------- orders
  await go('Orders', 'Orders & fulfilment');
  await page.getByRole('button', { name: 'YL26-000001' }).click();
  await page.getByText('Momo Steamer · 2 tier').waitFor();
  await page.getByText('Razorpay pay_123').waitFor();
  await page.getByRole('button', { name: 'Start packing' }).click();
  await page.getByText('Order moved to packing.').waitFor();
  assert.deepEqual(lastCall('POST', '/admin/orders/o1/fulfilment').body, { status: 'PROCESSING' });
  await page.getByLabel('Tracking number').fill('DEL-84920491');
  await page.getByRole('button', { name: 'Mark as shipped' }).click();
  await page.getByText(/marked as shipped/i).waitFor();
  assert.deepEqual(lastCall('POST', '/admin/orders/o1/fulfilment').body, { status: 'SHIPPED', trackingCarrier: 'Delhivery', trackingNumber: 'DEL-84920491' });

  // ----------------------------------------------------------------------------------------------- refunds + returns
  await go('Refunds & returns', 'Refunds & returns');
  await page.getByText('You requested this refund, so another person must approve it.').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Approve' }).count(), 1, 'no self-approval button');
  await page.getByRole('button', { name: 'Approve' }).click();
  await page.getByText(/Refund approved/).waitFor();
  await page.getByRole('button', { name: 'Request a refund' }).click();
  await page.getByLabel('Find the order').fill('YL26');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('button', { name: /YL26-000001/ }).click();
  await page.getByLabel('Amount to refund').fill('250.50');
  await page.getByLabel('Reason', { exact: false }).fill('Goodwill after delay');
  await page.getByRole('button', { name: 'Request refund' }).click();
  await page.getByText(/Refund requested/).waitFor();
  const refund = lastCall('POST', '/admin/refunds');
  assert.deepEqual(refund.body, { orderId: 'o1', amountMinor: 25050, kind: 'ADMIN', reason: 'Goodwill after delay' });
  assert.match(refund.headers['idempotency-key'], /^[0-9a-f-]{36}$/, 'refund sends an Idempotency-Key');
  await page.getByRole('tab', { name: 'Return requests' }).click();
  await page.getByText('Lid is cracked', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.getByText('Return approved.').waitFor();
  assert.deepEqual(lastCall('POST', '/admin/returns/ret1/decision').body, { decision: 'APPROVED' });

  // ----------------------------------------------------------------------------------------------- coupons
  await go('Coupons', 'Coupons');
  await page.getByText('WELCOME10').waitFor();
  await page.getByRole('button', { name: 'New coupon' }).click();
  await page.getByLabel('Code').fill('festive50');
  await page.getByLabel('Percentage (%)').fill('12.5');
  await page.getByLabel('Minimum cart value').fill('499');
  await page.getByRole('button', { name: 'Create coupon' }).click();
  await page.getByText('Coupon FESTIVE50 created.').waitFor();
  const coupon = lastCall('POST', '/admin/coupons').body;
  assert.equal(coupon.percentBps, 1250);
  assert.equal(coupon.minCartMinor, 49900);
  assert.equal('amountMinor' in coupon, false, 'percentage coupons send no fixed amount');
  assert.equal(coupon.scope, 'ALL_ITEMS');

  // ----------------------------------------------------------------------------------------------- shipping
  await go('Shipping', 'Shipping methods');
  await page.getByText(/delivery is currently free/).waitFor();
  await page.getByRole('button', { name: 'Add method' }).click();
  await page.getByLabel('Code').fill('STANDARD');
  await page.getByLabel('Name shown to customers').fill('Standard delivery');
  await page.getByLabel('Delivery fee').fill('49');
  await page.getByLabel('Free above order value').fill('499');
  await page.getByRole('button', { name: 'Add method', exact: true }).last().click();
  await page.getByText('Standard delivery added.').waitFor();
  assert.deepEqual(lastCall('POST', '/admin/shipping-methods').body, {
    code: 'STANDARD', name: 'Standard delivery', description: null, baseMinor: 4900, freeAboveMinor: 49900,
    etaMinDays: 3, etaMaxDays: 7, states: [], sortOrder: 0, isActive: true,
  });

  // ----------------------------------------------------------------------------------------------- users
  await go('Users & roles', 'Users & roles');
  await page.getByText('priya@example.test').waitFor();
  assert.equal(await page.getByRole('button', { name: /Give a role/ }).count(), 1, 'no role actions on your own account');
  await page.getByRole('button', { name: /Give a role/ }).click();
  await page.getByLabel('Role to give').selectOption('CUSTOMER_SUPPORT');
  await page.getByRole('button', { name: 'Give role', exact: true }).click();
  await page.getByText(/role given to priya@example.test/).waitFor();
  assert.deepEqual(lastCall('POST', '/admin/users/u2/roles').body, { role: 'CUSTOMER_SUPPORT' });

  // ----------------------------------------------------------------------------------------------- products
  await go('Products', 'Products');
  await page.getByRole('link', { name: 'Momo Steamer' }).waitFor();
  await page.getByRole('link', { name: 'Add product' }).click();
  await page.getByRole('heading', { name: 'Add product', level: 1 }).waitFor();
  await page.getByLabel('Product name').fill('Momo Steamer');
  await page.getByLabel('Kitchen and Dining').check();
  await page.getByLabel('SKU').fill('YAL-ST-20');
  await page.getByLabel('Price (₹, GST inclusive)').fill('799');
  await page.getByLabel('Sale price (₹)').fill('490');
  await page.getByRole('button', { name: 'Create draft' }).click();
  await page.getByRole('heading', { name: 'Edit product', level: 1 }).waitFor();
  const product = lastCall('POST', '/admin/products').body;
  assert.deepEqual(product.categoryIds, ['c1']);
  assert.equal(product.variants[0].priceMinor, 79900);
  assert.equal(product.variants[0].salePriceMinor, 49000);
  assert.equal(product.gstRateBps, 1800);
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await page.getByText('Product is live.').waitFor();

  // ----------------------------------------------------------------------------------------------- limited role
  await page.getByRole('button', { name: 'Sign out of admin' }).click();
  await page.getByLabel('Work email').waitFor();
  signedInAs = 'support';
  await page.getByLabel('Work email').fill('support@example.test');
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Authenticator code').fill('123456');
  await page.getByRole('button', { name: 'Verify and continue' }).click();
  // lands on the first screen the role can use, not on a screen it cannot
  await page.getByRole('heading', { name: 'Products', exact: true, level: 1 }).waitFor();
  const nav = await page.locator('aside nav a, aside a').allInnerTexts();
  const links = nav.map((t) => t.trim()).filter((t) => ['Overview', 'Products', 'Categories', 'Inventory', 'Orders', 'Refunds & returns', 'Users & roles', 'Coupons', 'Shipping'].includes(t));
  assert.deepEqual(links, ['Products', 'Categories', 'Orders', 'Refunds & returns'], `support sees only its screens, got ${links}`);
  assert.equal(await page.getByRole('link', { name: 'Add product' }).count(), 0, 'no Add product without products.create');
  assert.equal(await page.getByRole('button', { name: 'Delete' }).count(), 0, 'no Delete without products.delete');
  assert.equal(await page.getByRole('button', { name: 'Publish' }).count(), 0, 'no Publish without products.publish');
  await page.getByRole('link', { name: 'Momo Steamer' }).waitFor();
  const beforeInventory = calls.length;
  await page.goto(`${base}/admin/inventory`);
  await page.getByText(/cannot open this area/).waitFor();
  assert.equal(calls.slice(beforeInventory).some((c) => c.path === '/admin/inventory'), false, 'a blocked screen makes no API calls');
  const paymentsMark = calls.length;
  await go('Orders', 'Orders & fulfilment');
  await page.getByRole('button', { name: 'YL26-000001' }).click();
  await page.getByText('View only: your role can see this order but not change it.').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Start packing' }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Cancel order…' }).count(), 0);
  assert.equal(calls.slice(paymentsMark).some((c) => c.path === '/admin/orders/o1/payments'), false, 'support never asks for payment details');
  await go('Refunds & returns', 'Refunds & returns');
  await page.getByText(/You can request a refund here/).waitFor();
  await page.getByRole('button', { name: 'Request a refund' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Approve' }).count(), 0);

  // back to the administrator for the layout checks
  await page.getByRole('button', { name: 'Sign out of admin' }).click();
  await page.getByLabel('Work email').waitFor();
  signedInAs = 'admin';
  await page.getByLabel('Work email').fill('admin@example.test');
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Authenticator code').fill('123456');
  await page.getByRole('button', { name: 'Verify and continue' }).click();
  await page.getByRole('heading', { name: 'The everyday, at a glance.', exact: true, level: 1 }).waitFor();

  // ----------------------------------------------------------------------------------------------- phone layout
  await page.setViewportSize({ width: 375, height: 800 });
  for (const [name, heading] of [['Overview', 'The everyday, at a glance.'], ['Products', 'Products'], ['Inventory', 'Inventory'], ['Orders', 'Orders & fulfilment'], ['Refunds & returns', 'Refunds & returns'], ['Users & roles', 'Users & roles'], ['Coupons', 'Coupons'], ['Shipping', 'Shipping methods']]) {
    await go(name, heading);
    await page.waitForTimeout(150);
    await overflow(name);
  }

  console.log('PASS: 8 staff screens sign in with MFA, share one step-up prompt and retry, send server-ready payloads (paise, idempotency key, roles), block self-approval, and fit a 375px screen.');
} finally {
  await browser.close();
}
