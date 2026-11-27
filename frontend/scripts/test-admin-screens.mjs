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

const ALL_PERMISSIONS = ['analytics.read', 'products.read', 'products.create', 'products.update', 'products.delete', 'products.publish', 'inventory.read', 'inventory.adjust', 'orders.read', 'orders.update', 'shipments.manage', 'payments.read', 'refunds.create', 'refunds.approve', 'coupons.manage', 'reviews.moderate', 'users.manage', 'customers.suspend', 'customers.read', 'audit.read', 'pricing.update'];
const SUPPORT_PERMISSIONS = ['products.read', 'orders.read', 'refunds.create', 'customers.read', 'reviews.moderate'];
// The real FINANCE_MANAGER role (src/modules/access/permissions.ts): coupons, but no products.read.
const FINANCE_PERMISSIONS = ['orders.read', 'payments.read', 'refunds.create', 'refunds.approve', 'pricing.update', 'coupons.manage', 'audit.read', 'analytics.read'];
let signedInAs = 'admin';
const meFor = () => signedInAs === 'support'
  ? { id: 'staff-2', email: 'support@example.test', roles: ['CUSTOMER_SUPPORT'], mfaEnabled: true, permissions: SUPPORT_PERMISSIONS }
  : signedInAs === 'finance'
    ? { id: 'staff-3', email: 'finance@example.test', roles: ['FINANCE_MANAGER'], mfaEnabled: true, permissions: FINANCE_PERMISSIONS }
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
  productTotal: 21, // two pages of products until the one on page 2 is deleted
  productStatus: 'DRAFT',
  productSlug: 'momo-steamer',
  brands: [{ id: 'b1', name: 'Yalli', slug: 'yalli', _count: { products: 3 } }],
  reviews: [
    { id: 'rv1', product: { slug: 'momo-steamer', name: 'Momo Steamer' }, reviewer: 'Asha K.', rating: 4, title: 'Great steamer', body: 'Soft momos every time <b>not bold</b>.', status: 'PENDING', moderationNote: null, createdAt: '2026-11-18T10:00:00Z' },
    { id: 'rv2', product: { slug: 'momo-steamer', name: 'Momo Steamer' }, reviewer: 'Ravi S.', rating: 1, title: null, body: 'Buy cheap pills at my site now', status: 'PENDING', moderationNote: null, createdAt: '2026-11-18T11:00:00Z' },
  ],
  refunds: [
    { id: 'r-other', orderId: 'o1', order: { orderNumber: 'YL26-000001' }, kind: 'ADMIN', amountMinor: 50000, status: 'PENDING_APPROVAL', reason: 'Damaged on arrival', requestedById: 'someone-else', approvedById: null, createdAt: '2026-11-18T10:00:00Z', processedAt: null, failureReason: null },
    { id: 'r-mine', orderId: 'o1', order: { orderNumber: 'YL26-000001' }, kind: 'GOODWILL', amountMinor: 10000, status: 'PENDING_APPROVAL', reason: 'Late delivery gesture', requestedById: 'staff-1', approvedById: null, createdAt: '2026-11-18T11:00:00Z', processedAt: null, failureReason: null },
    { id: 'r-failed', orderId: 'o1', order: { orderNumber: 'YL26-000001' }, kind: 'CUSTOMER_CANCEL', amountMinor: 42000, status: 'FAILED', reason: 'Order cancelled', requestedById: null, approvedById: null, createdAt: '2026-11-18T08:00:00Z', processedAt: null, failureReason: 'Bank account closed', retryOfId: null, retriedBy: null },
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
  returns: [{ id: 'ret1', status: 'REQUESTED' }],
});
const salesDays = Array.from({ length: 30 }, (_, i) => ({ date: `2026-10-${String(21 + (i % 11)).padStart(2, '0')}`, paidOrders: i % 5, grossMinor: (i % 5) * 138000 }));

function handle(method, path, request) {
  const body = request.postData() && !(request.headers()['content-type'] ?? '').startsWith('multipart') ? request.postDataJSON() : undefined;
  calls.push({ method, path, url: request.url(), body, headers: request.headers() });
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
  if (m === 'GET /admin/products' && new URL(request.url()).searchParams.get('page') === '2') {
    const totalPages = Math.ceil(state.productTotal / 20);
    const items = state.productTotal > 20 ? [{ id: 'p2', slug: 'last-one', name: 'Last One', status: 'DRAFT', updatedAt: '2026-11-18T09:00:00Z', _count: { variants: 1, images: 0 }, categories: [], price: { minMinor: 100, maxMinor: 100, onSale: false }, stock: { available: 1, lowStock: false } }] : [];
    return ok(items, { page: 2, pageSize: 20, total: state.productTotal, totalPages });
  }
  if (m === 'DELETE /admin/products/p2') {
    state.productTotal = 20;
    return ok(null);
  }
  if (m === 'GET /admin/products') return ok([{ id: 'p1', slug: 'momo-steamer', name: 'Momo Steamer', status: 'DRAFT', updatedAt: '2026-11-18T09:00:00Z', _count: { variants: 1, images: 0 }, categories: ['Kitchen and Dining'], price: { minMinor: 49000, maxMinor: 79900, onSale: true }, stock: { available: 0, lowStock: false } }], { page: 1, pageSize: 20, total: state.productTotal, totalPages: Math.ceil(state.productTotal / 20) });
  if (m === 'GET /admin/brands') return ok(state.brands);
  if (m === 'POST /admin/brands') {
    const b = { id: `b${state.brands.length + 1}`, name: body.name, slug: body.slug ?? 'new', _count: { products: 0 } };
    state.brands.push(b);
    return { status: 201, json: { success: true, data: b } };
  }
  if (method === 'DELETE' && path.startsWith('/admin/brands/')) {
    state.brands = state.brands.filter((b) => `/admin/brands/${b.id}` !== path);
    return ok(null);
  }
  if (m === 'GET /admin/categories')
    return signedInAs === 'finance' ? fail(403, 'You do not have permission to perform this action', 'FORBIDDEN') : ok([{ id: 'c1', name: 'Kitchen and Dining', slug: 'kitchen-and-dining', parentId: null, position: 0, isActive: true, _count: { products: 1, children: 0 } }]);
  if (m === 'POST /admin/products') return { status: 201, json: { success: true, data: { id: 'p1' } } };
  if (m === 'GET /admin/products/p1')
    return ok({
      id: 'p1', slug: state.productSlug, name: 'Momo Steamer', summary: null, descriptionHtml: '', status: state.productStatus, brandId: null, gstRateBps: 1800, hsnCode: null,
      categories: [{ id: 'c1', name: 'Kitchen and Dining' }], tags: [], attributes: [],
      images: [
        { id: 'img1', url: null, altText: 'Front', position: 0, variantId: null },
        { id: 'img2', url: null, altText: 'Side', position: 1, variantId: null },
      ],
      variants: [
        { id: 'v1', sku: 'YAL-ST-20', name: null, priceMinor: 79900, salePriceMinor: 49000, saleStartsAt: null, saleEndsAt: null, isActive: true, weightGrams: null, available: 7 },
        { id: 'v2', sku: 'YAL-ST-30', name: '3 tier', priceMinor: 99900, salePriceMinor: null, saleStartsAt: null, saleEndsAt: null, isActive: true, weightGrams: null, available: 2 },
      ],
      updatedAt: '2026-11-18T09:00:00Z',
    });
  if (m === 'PATCH /admin/products/p1') {
    if (body.slug) state.productSlug = body.slug;
    return ok({});
  }
  if (m === 'POST /admin/products/p1/publish') { state.productStatus = 'PUBLISHED'; return ok({}); }
  if (m === 'POST /admin/products/p1/archive') { state.productStatus = 'ARCHIVED'; return ok({}); }
  if (m === 'POST /admin/products/p1/unpublish') { state.productStatus = 'DRAFT'; return ok({}); }
  if (method === 'PATCH' && path.startsWith('/admin/images/')) return ok({});

  // inventory
  if (m === 'GET /admin/inventory') return list([
    { sku: 'YAL-ST-20', product: 'Momo Steamer', warehouse: 'MAIN', onHand: 18, reserved: 6, available: 12, lowStockThreshold: 15 },
    { sku: 'YAL-KT-01', product: 'Kettle', warehouse: 'CHN', onHand: 40, reserved: 0, available: 40, lowStockThreshold: 5 },
  ]);
  if (m === 'GET /admin/warehouses') return ok([{ code: 'MAIN', name: 'Madurai', isDefault: true, isActive: true }, { code: 'CHN', name: 'Chennai', isDefault: false, isActive: true }]);
  if (m === 'GET /admin/inventory/movements') {
    const pageNo = Number(new URL(request.url()).searchParams.get('page') ?? 1);
    return ok([{ type: 'RECEIPT', onHandDelta: 5, reservedDelta: 0, onHandAfter: 18, reservedAfter: 6, reason: `Delivery p${pageNo}`, referenceType: null, createdAt: '2026-11-18T09:00:00Z' }], { page: pageNo, pageSize: 15, total: 30, totalPages: 2 });
  }
  if (m === 'POST /admin/inventory/adjustments') return ok({ sku: 'YAL-ST-20', onHand: 23, reserved: 6 });
  if (m === 'PATCH /admin/inventory/threshold') return ok({ sku: body.sku, warehouse: body.warehouseCode, lowStockThreshold: body.lowStockThreshold });
  if (m === 'POST /admin/warehouses') return { status: 201, json: { success: true, data: { id: 'w3', code: body.code.toUpperCase(), name: body.name, isDefault: false, isActive: true } } };
  if (method === 'PATCH' && path.startsWith('/admin/warehouses/')) return ok({});

  // orders
  if (m === 'GET /admin/orders') return list([{ id: 'o1', orderNumber: 'YL26-000001', status: state.orderStatus, placedAt: '2026-11-18T09:00:00Z', totalMinor: 138000, contactEmail: 'ananya@example.test', shipCity: 'Madurai', shipState: 'Tamil Nadu' }]);
  if (m === 'GET /admin/orders/o1') return ok(orderDetail());
  if (m === 'GET /admin/orders/o1/tracking') return ok({ shipment: null });
  if (m === 'POST /admin/orders/o1/tracking') return ok({});
  if (m === 'GET /admin/orders/o1/invoice')
    return ok({
      invoiceNumber: 'INV/2627/000042', invoiceDate: '2026-11-18T09:05:00Z', orderNumber: 'YL26-000001', taxInvoice: false,
      seller: { name: 'Yalli', state: 'Tamil Nadu', gstin: null }, buyer: { name: 'Ananya <b>R</b>', email: 'ananya@example.test' },
      placeOfSupply: 'Tamil Nadu', supply: 'INTRA_STATE', currency: 'INR',
      lines: [{ description: 'Momo Steamer', sku: 'YAL-ST-20', hsn: null, quantity: 2, unitPriceMinor: 69000, discountMinor: 0, taxableValueMinor: 116949, gstRateBps: 1800, cgstMinor: 10525, sgstMinor: 10526, igstMinor: 0, lineTotalMinor: 138000 }],
      totals: { subtotalMinor: 138000, totalMinor: 138000 },
    });
  if (m === 'GET /admin/orders/o1/credit-notes') return ok([]);
  if (m === 'GET /admin/orders/o1/payments') return ok([{ id: 'pay1', status: 'CAPTURED', amountMinor: 138000, capturedMinor: 138000, refundedMinor: 0, attempt: 1, method: 'upi', providerPaymentId: 'pay_123', failureCode: null, createdAt: '2026-11-18T09:01:00Z' }]);
  if (m === 'POST /admin/orders/o1/cancel') return fail(409, 'This order is being packed and cannot be cancelled now', 'CONFLICT');
  if (m === 'POST /admin/orders/o1/fulfilment') {
    state.orderStatus = body.status;
    return ok({});
  }

  // refunds + returns
  if (m === 'GET /admin/refunds') return list(state.refunds);
  if (m === 'POST /admin/refunds') return { status: 201, json: { success: true, data: { id: 'r-new', status: 'PENDING_APPROVAL', amountMinor: body.amountMinor } } };
  if (m === 'POST /admin/refunds/r-failed/retry') {
    const r = state.refunds.find((x) => x.id === 'r-failed');
    r.retriedBy = { id: 'r-retry', status: 'PENDING_APPROVAL' };
    return { status: 201, json: { success: true, data: { id: 'r-retry', status: 'PENDING_APPROVAL', amountMinor: 42000, retryOfId: 'r-failed' } } };
  }
  // finance
  if (m === 'GET /admin/credit-notes')
    return list([{ id: 'cn1', creditNoteNumber: 'CN/2627/000001', issuedAt: '2026-11-18T12:00:00Z', invoiceNumber: 'INV/2627/000042', totalMinor: 50000, taxableValueMinor: 42373, cgstMinor: 3813, sgstMinor: 3814, igstMinor: 0, order: { orderNumber: 'YL26-000001' } }]);
  if (m === 'GET /admin/credit-notes/export' || m === 'GET /admin/refunds/export')
    return { status: 200, contentType: 'text/csv; charset=utf-8', headers: { 'content-disposition': `attachment; filename="${path.includes('credit') ? 'credit-notes' : 'refunds'}-2026-11-01.csv"` }, body: '"Note number"\r\n"CN/2627/000001"\r\n' };
  if (m === 'GET /admin/credit-notes/cn1')
    return ok({
      id: 'cn1', creditNoteNumber: 'CN/2627/000001', issuedAt: '2026-11-18T12:00:00Z', financialYear: '2026-27', invoiceNumber: 'INV/2627/000042', orderNumber: 'YL26-000001',
      reason: 'Damaged on arrival', taxDocument: false, seller: { name: 'Yalli', state: 'Tamil Nadu', gstin: null }, buyer: { name: 'Ananya', email: 'ananya@example.test' },
      placeOfSupply: 'Tamil Nadu', supply: 'INTRA_STATE', currency: 'INR',
      lines: [{ kind: 'GOODS', description: 'Momo Steamer', hsn: null, gstRateBps: 1800, taxableValueMinor: 42373, cgstMinor: 3813, sgstMinor: 3814, igstMinor: 0, totalMinor: 50000 }],
      totals: { taxableValueMinor: 42373, cgstMinor: 3813, sgstMinor: 3814, igstMinor: 0, totalMinor: 50000 },
    });
  // customers (support lookup)
  if (m === 'POST /admin/customers/search')
    return ok(body?.email === 'priya@example.test'
      ? [{ id: 'u2', name: 'Priya R', email: 'pr•••@example.test', phone: '+91 ••••• •3210', status: 'ACTIVE', emailVerified: true, phoneVerified: false, mfaEnabled: false, createdAt: '2026-11-02T00:00:00Z', lastLoginAt: null }]
      : []);
  if (m === 'GET /admin/customers/u2')
    return ok({
      id: 'u2', name: 'Priya R', email: 'pr•••@example.test', phone: '+91 ••••• •3210', status: 'ACTIVE', emailVerified: true, phoneVerified: false, mfaEnabled: false, createdAt: '2026-11-02T00:00:00Z', lastLoginAt: null,
      orders: [{ id: 'o1', orderNumber: 'YL26-000001', status: 'DELIVERED', placedAt: '2026-11-18T09:00:00Z', totalMinor: 138000 }],
      returns: [{ id: 'ret1', status: 'REQUESTED', quantity: 1, reason: 'FAULTY', createdAt: '2026-11-18T12:00:00Z', order: { id: 'o1', orderNumber: 'YL26-000001' }, item: { productName: 'Momo Steamer' } }],
    });
  // contact messages
  if (m === 'GET /admin/contact-messages')
    return list((state.messages ??= [{ id: 'cm1', name: 'Kavya', email: 'kavya@example.test', orderNumber: 'YL26-000001', topic: 'ORDER', message: 'Where is my <b>parcel</b>?', status: 'NEW', createdAt: '2026-11-18T08:00:00Z', handledAt: null }]).filter((x) => x.status === new URL(request.url()).searchParams.get('status')));
  if (m === 'POST /admin/contact-messages/cm1/handled') {
    state.messages[0].status = 'HANDLED';
    state.messages[0].handledAt = '2026-11-18T09:00:00Z';
    return ok(null);
  }
  // audit log
  if (m === 'GET /admin/audit-logs/actions') return ok({ actions: ['auth.login.succeeded', 'refund.approved', 'refund.requested'], categories: ['auth', 'refund'] });
  if (m === 'GET /admin/audit-logs')
    return ok([
      { id: 'a1', occurredAt: '2026-11-18T10:00:00Z', actorId: 'staff-3', actorType: 'USER', actorLabel: 'finance@example.test', action: 'refund.approved', resourceType: 'refund', resourceId: 'r-other', outcome: 'SUCCESS', ip: '10.0.0.1', correlationId: 'c1', metadata: { amountMinor: 50000, note: '<b>not bold</b>' } },
      { id: 'a2', occurredAt: '2026-11-18T09:00:00Z', actorId: null, actorType: 'ANONYMOUS', actorLabel: null, action: 'auth.login.failed', resourceType: null, resourceId: null, outcome: 'FAILURE', ip: '10.0.0.9', correlationId: null, metadata: null },
    ], { page: 1, pageSize: 50, total: 2, totalPages: 1, from: '2026-11-11T00:00:00Z', to: '2026-11-18T23:00:00Z' });
  // catalogue import (multipart: the options are form fields)
  if (m === 'POST /admin/catalog/import') {
    const raw = request.postData() ?? '';
    const apply = /name="apply"\r\n\r\ntrue/.test(raw);
    state.importCalls = (state.importCalls ?? []).concat({ apply, hasFile: raw.includes('filename="catalog.json"') });
    return ok({ mode: apply ? 'APPLIED' : 'DRY_RUN', categories: { created: 1, existing: 0 }, brands: { created: 0, existing: 1 }, products: { created: 2, updated: 0, skipped: 0, failed: 0 }, variants: { created: 3, updated: 0 }, failures: [] });
  }
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

  // reviews
  if (m === 'GET /admin/reviews') return list(state.reviews.filter((r) => r.status === (request.url().includes('status=') ? new URL(request.url()).searchParams.get('status') : 'PENDING')));
  if (m === 'POST /admin/reviews/rv1/take-down') {
    const r = state.reviews.find((x) => x.id === 'rv1');
    r.status = 'REJECTED';
    r.moderationNote = body.note;
    return ok({ id: 'rv1', status: 'REJECTED' });
  }
  if (m === 'POST /admin/reviews/rv1/decision' || m === 'POST /admin/reviews/rv2/decision') {
    const r = state.reviews.find((x) => `/admin/reviews/${x.id}/decision` === path);
    r.status = body.decision;
    r.moderationNote = body.note ?? null;
    return ok({ id: r.id, status: r.status });
  }

  // users
  if (m === 'GET /admin/roles') return ok([
    { name: 'SUPER_ADMIN', description: 'Everything', rank: 100, permissions: ['users.manage'], assignable: false },
    { name: 'CUSTOMER', description: 'Shopper', rank: 0, permissions: [], assignable: true },
    { name: 'CUSTOMER_SUPPORT', description: 'Helps customers', rank: 10, permissions: ['orders.read'], assignable: true },
  ]);
  if (m === 'PATCH /admin/variants/v1') return ok({});
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
  await page.locator('aside').getByRole('link', { name, exact: true }).click();
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
  await page.getByRole('button', { name: 'Adjust', exact: true }).first().click();
  assert.equal(await page.getByLabel('Warehouse', { exact: true }).inputValue(), 'Madurai (MAIN)', 'the row\'s warehouse, fixed');
  await page.getByLabel('Quantity').fill('5');
  await page.getByLabel('Reason').fill('Supplier delivery');
  await page.getByRole('button', { name: 'Save adjustment' }).click();
  await page.getByText('YAL-ST-20: stock is now 23 on hand.').waitFor();
  assert.deepEqual(lastCall('POST', '/admin/inventory/adjustments').body, { sku: 'YAL-ST-20', warehouseCode: 'MAIN', delta: 5, type: 'RECEIPT', reason: 'Supplier delivery' });
  // the second row is in another warehouse: its Adjust changes THAT warehouse
  await page.getByRole('button', { name: 'Adjust', exact: true }).nth(1).click();
  await page.getByLabel('Quantity').fill('2');
  await page.getByLabel('Reason').fill('Recount');
  await page.getByRole('button', { name: 'Save adjustment' }).click();
  await page.getByText(/stock is now/).last().waitFor();
  assert.equal(lastCall('POST', '/admin/inventory/adjustments').body.warehouseCode, 'CHN');
  // history: page 2 for one SKU, then another SKU starts again on page 1
  await page.getByRole('button', { name: 'History' }).first().click();
  await page.getByText('Delivery p1').waitFor();
  await page.getByRole('region', { name: /Stock history/ }).getByRole('button', { name: 'Next' }).click();
  await page.getByText('Delivery p2').waitFor();
  await page.getByRole('button', { name: 'History' }).nth(1).click();
  await page.getByRole('heading', { name: 'Stock history · YAL-KT-01' }).waitFor();
  await page.getByText('Delivery p1').waitFor();
  const lastHistory = calls.filter((c) => c.path === '/admin/inventory/movements').at(-1);
  assert.ok(lastHistory, 'history was requested');
  // low-stock level of one row
  await page.getByRole('button', { name: 'Change low-stock level for YAL-ST-20' }).click();
  await page.getByLabel('Low-stock level for YAL-ST-20').fill('20');
  await page.getByLabel('Low-stock level for YAL-ST-20').press('Enter');
  await page.getByText('YAL-ST-20: low-stock level is now 20.').waitFor();
  assert.deepEqual(lastCall('PATCH', '/admin/inventory/threshold').body, { sku: 'YAL-ST-20', warehouseCode: 'MAIN', lowStockThreshold: 20 });
  // warehouses: add one, make another the default
  const panel = page.getByRole('region', { name: 'Warehouses' });
  await panel.getByLabel('Code').fill('blr-1');
  await panel.getByLabel('Warehouse name').fill('Bengaluru');
  await panel.getByRole('button', { name: 'Add warehouse' }).click();
  await panel.getByText('Warehouse BLR-1 added.').waitFor();
  assert.deepEqual(lastCall('POST', '/admin/warehouses').body, { code: 'blr-1', name: 'Bengaluru' });
  await panel.getByRole('listitem').filter({ hasText: 'Chennai' }).getByRole('button', { name: 'Make default' }).click();
  await panel.getByText('Chennai is now the default warehouse.').waitFor();
  assert.deepEqual(lastCall('PATCH', '/admin/warehouses/CHN').body, { isDefault: true });

  // ----------------------------------------------------------------------------------------------- orders
  await go('Orders', 'Orders & fulfilment');
  await page.getByRole('button', { name: 'YL26-000001' }).click();
  await page.getByText('Momo Steamer · 2 tier').waitFor();
  await page.getByText('Razorpay pay_123').waitFor();
  // a refused cancellation keeps the form (and the typed reason) open, with the server's reason
  await page.getByRole('button', { name: 'Cancel order…' }).click();
  await page.getByLabel('Reason (shown in the order history)').fill('Customer asked');
  await page.getByRole('button', { name: 'Confirm cancellation' }).click();
  await page.getByText('This order is being packed and cannot be cancelled now').waitFor();
  assert.equal(await page.getByLabel('Reason (shown in the order history)').inputValue(), 'Customer asked', 'the form stays open on failure');
  await page.getByRole('button', { name: 'Keep order' }).click();
  await page.getByRole('button', { name: 'Start packing' }).click();
  await page.getByText('Order moved to packing.').waitFor();
  assert.deepEqual(lastCall('POST', '/admin/orders/o1/fulfilment').body, { status: 'PROCESSING' });
  await page.getByLabel('Tracking number').fill('DEL-84920491');
  await page.getByRole('button', { name: 'Mark as shipped' }).click();
  await page.getByText(/marked as shipped/i).waitFor();
  assert.deepEqual(lastCall('POST', '/admin/orders/o1/fulfilment').body, { status: 'SHIPPED', trackingCarrier: 'Delhivery', trackingNumber: 'DEL-84920491' });
  // a tracking update can carry the time the courier reported (not just "now")
  await page.getByLabel('When it happened (optional)').fill('2026-11-18T10:30');
  await page.getByRole('button', { name: 'Add update' }).click();
  await page.getByText('Tracking update added.').waitFor();
  const tracked = lastCall('POST', '/admin/orders/o1/tracking').body;
  assert.equal(tracked.status, 'IN_TRANSIT');
  assert.equal(new Date(tracked.occurredAt).getTime(), new Date('2026-11-18T10:30').getTime(), 'occurredAt is the typed local time');
  // the invoice opens in a new window, buyer data escaped
  const [invoiceWindow] = await Promise.all([page.context().waitForEvent('page'), page.getByRole('button', { name: 'Invoice', exact: true }).click()]);
  await invoiceWindow.waitForFunction(() => !document.body?.innerText.includes('Preparing the invoice'), null, { timeout: 10_000 });
  const invoiceHtml = await invoiceWindow.content();
  assert.ok(invoiceHtml.includes('INV/2627/000042'), 'invoice number shown');
  assert.ok(invoiceHtml.includes('Ananya &lt;b&gt;R&lt;/b&gt;'), 'buyer name escaped');
  await invoiceWindow.close();

  // ----------------------------------------------------------------------------------------------- refunds + returns
  await go('Refunds & returns', 'Refunds & returns');
  await page.getByText('You requested this refund, so another person must approve it.').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Approve' }).count(), 1, 'no self-approval button');
  await page.getByRole('button', { name: 'Approve' }).click();
  await page.getByText(/Refund approved/).waitFor();
  // a failed refund can be retried as a new request (four-eyes again), with an Idempotency-Key
  await page.getByText('Bank account closed').waitFor();
  await page.getByRole('button', { name: 'Retry refund…' }).click();
  await page.getByText('Retry requested. A second person must approve it before any money moves.').waitFor();
  const retried = lastCall('POST', '/admin/refunds/r-failed/retry');
  assert.match(retried.headers['idempotency-key'], /^[0-9a-f-]{36}$/);
  await page.getByText(/Retried as a new request/).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Retry refund…' }).count(), 0, 'retried once only');
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

  // the order page links to that order's return requests; the returns list filters by status
  await go('Orders', 'Orders & fulfilment');
  await page.getByRole('button', { name: 'YL26-000001' }).click();
  await page.getByRole('link', { name: /1 return request/ }).click();
  await page.waitForURL(/\/admin\/refunds\?tab=returns&order=o1/);
  await page.getByText('Lid is cracked', { exact: false }).waitFor();
  assert.equal(new URL(lastCall('GET', '/admin/returns').url).searchParams.get('orderId'), 'o1');
  await Promise.all([page.waitForResponse((r) => r.url().includes('/admin/returns?') && r.url().includes('status=REQUESTED')), page.getByLabel('Filter returns by status').selectOption('REQUESTED')]);
  await page.getByText('Lid is cracked', { exact: false }).waitFor();
  assert.equal(new URL(lastCall('GET', '/admin/returns').url).searchParams.get('status'), 'REQUESTED');

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
  // a coupon for chosen products: search, add, create
  await page.getByRole('button', { name: 'New coupon' }).click();
  await page.getByLabel('Code').fill('momo5');
  await page.getByLabel('Percentage (%)').fill('5');
  await page.getByRole('radio', { name: 'Only selected products' }).check();
  await page.getByLabel('Find a product').fill('momo');
  await page.getByRole('button', { name: 'Search products' }).click();
  await page.getByRole('button', { name: 'Add Momo Steamer' }).click();
  await page.getByRole('list', { name: 'Selected products' }).getByText('Momo Steamer').waitFor();
  await page.getByRole('button', { name: 'Create coupon' }).click();
  await page.getByText('Coupon MOMO5 created.').waitFor();
  const productCoupon = lastCall('POST', '/admin/coupons').body;
  assert.equal(productCoupon.scope, 'PRODUCTS');
  assert.deepEqual(productCoupon.productIds, ['p1']);

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

  // ----------------------------------------------------------------------------------------------- finance
  await go('Finance', 'Finance');
  await page.getByRole('cell', { name: 'CN/2627/000001', exact: true }).waitFor();
  const finUrl = new URL(lastCall('GET', '/admin/credit-notes').url);
  assert.match(finUrl.searchParams.get('from'), /^\d{4}-\d{2}-01T00:00:00\+05:30$/, 'an India calendar month');
  const [cnWindow] = await Promise.all([page.context().waitForEvent('page'), page.getByRole('button', { name: 'View credit note CN/2627/000001' }).click()]);
  await cnWindow.waitForFunction(() => !document.body?.innerText.includes('Preparing the credit note'), null, { timeout: 10_000 });
  assert.ok((await cnWindow.content()).includes('CN/2627/000001'));
  await cnWindow.close();
  for (const [button, prefix] of [['Credit notes CSV (GSTR-1)', 'credit-notes'], ['Refund reconciliation CSV', 'refunds']]) {
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: button }).click()]);
    assert.equal(download.suggestedFilename(), `${prefix}-2026-11-01.csv`);
  }
  assert.ok(lastCall('GET', '/admin/refunds/export') && lastCall('GET', '/admin/credit-notes/export'));

  // ----------------------------------------------------------------------------------------------- customers
  await go('Customers', 'Customers');
  await page.getByRole('textbox', { name: 'Email address' }).fill('nobody@example.test');
  await page.getByRole('button', { name: 'Find customer' }).click();
  await page.getByText('No customer matches.', { exact: false }).waitFor();
  await page.getByRole('textbox', { name: 'Email address' }).fill('priya@example.test');
  await page.getByRole('button', { name: 'Find customer' }).click();
  await page.getByText('pr•••@example.test', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Open' }).click();
  await page.getByRole('heading', { name: 'Recent orders' }).waitFor();
  await page.getByRole('region', { name: 'Customer details' }).getByText('YL26-000001').first().waitFor();
  assert.equal(await page.getByText('priya@example.test').count(), 0, 'the full address is never shown');
  await page.getByRole('region', { name: 'Customer details' }).getByRole('link', { name: 'Open' }).waitFor();
  // the searched address travels in the request body, never in a URL
  assert.ok(calls.filter((c) => c.path.startsWith('/admin/customers')).every((c) => !c.url.includes('priya')));
  assert.deepEqual(lastCall('POST', '/admin/customers/search').body, { email: 'priya@example.test' });

  // ----------------------------------------------------------------------------------------------- messages
  await go('Messages', 'Messages');
  await page.getByText('Where is my <b>parcel</b>?').waitFor(); // plain text
  await page.getByText('are not verified', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Mark as handled' }).click();
  await page.getByText('No new messages').waitFor();
  await page.getByRole('button', { name: 'Handled', exact: true }).click();
  await page.getByText('Kavya', { exact: false }).waitFor();

  // ----------------------------------------------------------------------------------------------- audit log
  await go('Audit log', 'Audit log');
  await page.getByRole('cell', { name: 'refund.approved' }).waitFor(); // (also an option of the Event filter)
  await page.getByText('finance@example.test').waitFor();
  await page.getByRole('button', { name: 'Details' }).click();
  await page.getByText('<b>not bold</b>', { exact: false }).waitFor(); // metadata shown as text
  assert.equal(await page.locator('pre b').count(), 0);
  await Promise.all([page.waitForResponse((r) => r.url().includes('/admin/audit-logs?') && r.url().includes('category=refund')), page.getByLabel('Area').selectOption('refund')]);

  // ----------------------------------------------------------------------------------------------- import
  await go('Import', 'Import products');
  assert.equal(await page.getByRole('button', { name: 'Import now' }).isDisabled(), true, 'no import before a check');
  await page.locator('input[type=file]').setInputFiles({ name: 'catalog.json', mimeType: 'application/json', buffer: Buffer.from('{"version":1}') });
  await page.getByRole('button', { name: 'Check file' }).click();
  await page.getByRole('heading', { name: 'What the import would do' }).waitFor();
  await page.getByRole('button', { name: 'Import now' }).click();
  await page.getByText('Import finished.', { exact: false }).waitFor();
  assert.deepEqual(state.importCalls, [{ apply: false, hasFile: true }, { apply: true, hasFile: true }]);

  // ----------------------------------------------------------------------------------------------- users
  await go('Users & roles', 'Users & roles');
  await page.getByText('priya@example.test').waitFor();
  assert.equal(await page.getByRole('button', { name: /Give a role/ }).count(), 1, 'no role actions on your own account');
  await page.getByRole('button', { name: /Give a role/ }).click();
  const offered = await page.getByLabel('Role to give').locator('option').allInnerTexts();
  assert.ok(!offered.some((t) => /super/i.test(t)), `a role the caller may not give is not offered: ${offered}`);
  await page.getByLabel('Role to give').selectOption('CUSTOMER_SUPPORT');
  await page.getByRole('button', { name: 'Give role', exact: true }).click();
  await page.getByText(/role given to priya@example.test/).waitFor();
  assert.deepEqual(lastCall('POST', '/admin/users/u2/roles').body, { role: 'CUSTOMER_SUPPORT' });

  // ----------------------------------------------------------------------------------------------- reviews
  await go('Reviews', 'Reviews');
  await page.getByText('Soft momos every time <b>not bold</b>.').waitFor(); // shown as plain text, never as markup
  assert.equal(await page.locator('b').filter({ hasText: 'not bold' }).count(), 0, 'review text is escaped');
  await page.getByRole('img', { name: '4 out of 5 stars' }).waitFor();
  await page.locator('li').filter({ hasText: 'Great steamer' }).getByRole('button', { name: 'Approve' }).click();
  await page.getByText('Review published on the product page.').waitFor();
  assert.deepEqual(lastCall('POST', '/admin/reviews/rv1/decision').body, { decision: 'APPROVED' });
  await page.locator('li').filter({ hasText: 'cheap pills' }).getByRole('button', { name: 'Reject…' }).click();
  await page.getByLabel('Reason (shown to the customer)').fill('Spam');
  await page.getByRole('button', { name: 'Reject review' }).click();
  await page.getByText(/Review rejected/).waitFor();
  assert.deepEqual(lastCall('POST', '/admin/reviews/rv2/decision').body, { decision: 'REJECTED', note: 'Spam' });
  await page.getByText('Nothing is waiting').waitFor();
  await page.getByRole('tab', { name: 'Rejected' }).click();
  await page.getByText('Moderator note: Spam').waitFor();
  // a published review can be taken down later, with a reason
  await page.getByRole('tab', { name: 'Published' }).click();
  await page.getByRole('button', { name: 'Take down…' }).click();
  await page.getByLabel('Reason (shown to the customer)').fill('Shares a phone number');
  await page.getByRole('button', { name: 'Take down review' }).click();
  await page.getByText('Review taken down. The customer sees your reason.').waitFor();
  assert.deepEqual(lastCall('POST', '/admin/reviews/rv1/take-down').body, { note: 'Shares a phone number' });

  // ----------------------------------------------------------------------------------------------- products
  await go('Products', 'Products');
  await page.getByRole('link', { name: 'Momo Steamer' }).waitFor();
  await page.getByRole('cell', { name: /₹490\.00 – ₹799\.00/ }).waitFor();
  await page.getByText('On sale', { exact: true }).waitFor();
  await page.getByText('Out of stock', { exact: true }).waitFor();
  await page.getByText('no images').waitFor();
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
  // editing only the variant name sends only the name (no price fields, so no pricing.update needed)
  await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
  await page.getByLabel('Variant name').first().fill('2 tier');
  await page.getByRole('button', { name: 'Save variant' }).click();
  await page.getByRole('button', { name: 'Save variant' }).waitFor({ state: 'detached' });
  assert.deepEqual(lastCall('PATCH', '/admin/variants/v1').body, { name: '2 tier' });
  // the slug of an existing product can be changed (sent only when it changed)
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.getByText('Product saved.', { exact: true }).waitFor();
  assert.equal('slug' in lastCall('PATCH', '/admin/products/p1').body, false, 'unchanged slug not sent');
  await page.getByLabel('URL slug').fill('momo-steamer-v2');
  await page.getByText(/breaks old links/).waitFor();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.getByText('Its address is now /products/momo-steamer-v2.', { exact: false }).waitFor();
  assert.equal(lastCall('PATCH', '/admin/products/p1').body.slug, 'momo-steamer-v2');
  // images: move one earlier, show one only for a variant
  await Promise.all([page.waitForResponse((r) => r.url().endsWith('/admin/images/img2')), page.getByRole('button', { name: 'Move image 2 earlier' }).click()]);
  assert.deepEqual(lastCall('PATCH', '/admin/images/img2').body, { position: 0 });
  await Promise.all([page.waitForResponse((r) => r.url().endsWith('/admin/images/img1')), page.getByLabel('Image 1 shows').selectOption('v2')]);
  assert.deepEqual(lastCall('PATCH', '/admin/images/img1').body, { variantId: 'v2' });
  // archive, then restore as a draft
  await page.getByRole('button', { name: 'Archive' }).click();
  await page.getByText('Product archived.').waitFor();
  await page.getByRole('button', { name: 'Restore as draft' }).click();
  await page.getByText('Product restored as a draft.', { exact: false }).waitFor();
  assert.ok(lastCall('POST', '/admin/products/p1/unpublish'), 'restore uses the unpublish endpoint');
  // brands: create one (slug from the name), delete one
  await go('Brands', 'Brands');
  await page.getByText('/brands/yalli · 3 products').waitFor();
  await page.getByLabel('Brand name').fill('Prestige Kitchen');
  assert.equal(await page.getByLabel('URL slug').inputValue(), 'prestige-kitchen');
  await page.getByRole('button', { name: 'Create brand' }).click();
  await page.getByText('Brand Prestige Kitchen created.').waitFor();
  assert.deepEqual(lastCall('POST', '/admin/brands').body, { name: 'Prestige Kitchen', slug: 'prestige-kitchen' });
  await page.getByRole('button', { name: 'Delete Yalli' }).click();
  await page.getByText('Brand Yalli deleted.').waitFor();
  assert.ok(lastCall('DELETE', '/admin/brands/b1'));
  // deleting the only row on the last page goes back to the last page that exists
  await go('Products', 'Products');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('link', { name: 'Last One' }).waitFor();
  await page.getByRole('row', { name: /Last One/ }).getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('link', { name: 'Momo Steamer' }).waitFor();
  assert.equal(new URL(lastCall('GET', '/admin/products').url).searchParams.get('page'), '1', 'stepped back to page 1');
  assert.equal(await page.getByRole('navigation', { name: 'Pagination' }).count(), 0, 'one page left: no pager');

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
  const links = nav.map((t) => t.trim()).filter((t) => ['Overview', 'Products', 'Categories', 'Brands', 'Import', 'Inventory', 'Orders', 'Refunds & returns', 'Finance', 'Customers', 'Messages', 'Reviews', 'Users & roles', 'Audit log', 'Coupons', 'Shipping'].includes(t));
  assert.deepEqual(links, ['Products', 'Categories', 'Brands', 'Orders', 'Refunds & returns', 'Customers', 'Messages', 'Reviews'], `support sees only its screens, got ${links}`);
  assert.equal(await page.getByRole('link', { name: 'Add product' }).count(), 0, 'no Add product without products.create');
  assert.equal(await page.getByRole('button', { name: 'Delete' }).count(), 0, 'no Delete without products.delete');
  assert.equal(await page.getByRole('button', { name: 'Publish' }).count(), 0, 'no Publish without products.publish');
  await page.getByRole('link', { name: 'Momo Steamer' }).waitFor();
  // categories: readable with products.read, but no form or edit buttons without products.update
  await go('Categories', 'Categories');
  await page.getByText('Kitchen and Dining').waitFor();
  await page.getByText('You can view categories.', { exact: false }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'Add category' }).count(), 0, 'no category form without products.update');
  assert.equal(await page.getByRole('button', { name: /^Edit / }).count(), 0, 'no edit buttons');
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

  // ----------------------------------------------------------------------------------------------- finance role
  await page.getByRole('button', { name: 'Sign out of admin' }).click();
  await page.getByLabel('Work email').waitFor();
  signedInAs = 'finance';
  await page.getByLabel('Work email').fill('finance@example.test');
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Authenticator code').fill('123456');
  await page.getByRole('button', { name: 'Verify and continue' }).click();
  await page.locator('aside').getByRole('link', { name: 'Coupons' }).waitFor();
  await go('Coupons', 'Coupons');
  const financeMark = calls.length;
  await page.getByRole('button', { name: 'New coupon' }).click();
  await page.getByLabel('Code').fill('refund10');
  await page.getByLabel('Percentage (%)').fill('10');
  await page.getByText('Category coupons need product access').waitFor();
  assert.equal(await page.getByRole('radio', { name: 'Only selected categories' }).isDisabled(), true);
  await page.getByRole('button', { name: 'Create coupon' }).click();
  await page.getByText('Coupon REFUND10 created.').waitFor();
  assert.equal(lastCall('POST', '/admin/coupons').body.scope, 'ALL_ITEMS');
  assert.equal(calls.slice(financeMark).some((c) => c.path === '/admin/categories'), false, 'no category request without products.read');

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
  for (const [name, heading] of [['Overview', 'The everyday, at a glance.'], ['Products', 'Products'], ['Brands', 'Brands'], ['Import', 'Import products'], ['Inventory', 'Inventory'], ['Finance', 'Finance'], ['Customers', 'Customers'], ['Messages', 'Messages'], ['Audit log', 'Audit log'], ['Orders', 'Orders & fulfilment'], ['Refunds & returns', 'Refunds & returns'], ['Reviews', 'Reviews'], ['Users & roles', 'Users & roles'], ['Coupons', 'Coupons'], ['Shipping', 'Shipping methods']]) {
    await go(name, heading);
    await page.waitForTimeout(150);
    await overflow(name);
  }

  console.log('PASS: 9 staff screens sign in with MFA, share one step-up prompt and retry, send server-ready payloads (paise, idempotency key, roles), block self-approval, and fit a 375px screen.');
} finally {
  await browser.close();
}
