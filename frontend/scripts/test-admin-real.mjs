// Drives the staff screens (built Next app) against the REAL Nest backend + real PostgreSQL (no fake HTTP boundary).
// 1) from the repo root:  npm run serve:browser        (boots the app with fixtures, writes the info file)
// 2) in frontend/:        npx next start -p 3199        (a build made with `npm run build`)
// 3) in frontend/:        FRONTEND_URL=http://localhost:3199 PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
//                           node scripts/test-admin-real.mjs
// Browser /api/v1 calls are redirected to the backend, so the frontend's baked proxy target does not matter.
// Restart step 1 before every run (the seeded admin's one-time codes and the fixtures are consumed).
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const info = JSON.parse(readFileSync(process.env.SERVE_INFO_FILE || join(tmpdir(), 'yalli-serve-info.json'), 'utf8'));
const BACKEND = `http://127.0.0.1:${info.port}`;
const base = process.env.FRONTEND_URL || 'http://localhost:3199';

// ---- RFC 6238 TOTP (no dependency); the server accepts +/-1 step and refuses a step twice
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32decode(s) {
  let bits = '';
  for (const ch of s.replace(/=+$/, '').toUpperCase()) bits += B32.indexOf(ch).toString(2).padStart(5, '0');
  return Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
}
function code(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', b32decode(secret)).update(counter).digest();
  const o = h[19] & 15;
  return String(((h[o] & 127) << 24 | h[o + 1] << 16 | h[o + 2] << 8 | h[o + 3]) % 1_000_000).padStart(6, '0');
}
const used = new Set(info.usedSteps);
async function nextCode() {
  for (;;) {
    const cur = Math.floor(Date.now() / 30000);
    for (const st of [cur, cur + 1, cur - 1]) if (!used.has(st)) { used.add(st); return code(info.admin.secret, st); }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
const page = await browser.newPage();
page.on('dialog', (d) => void d.accept());
const pageErrors = [];
const serverErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('response', (r) => { if (r.url().includes('/api/v1/') && r.status() >= 500) serverErrors.push(`${r.status()} ${r.request().method()} ${r.url()}`); });
await page.route('**/api/v1/**', (route) => {
  const u = new URL(route.request().url());
  return route.continue({ url: `${BACKEND}${u.pathname}${u.search}` });
});

const step = (m) => console.log(`  - ${m}`);
const go = async (name, heading) => {
  await page.getByRole('link', { name, exact: true }).click();
  await page.getByRole('heading', { name: heading, exact: true, level: 1 }).waitFor();
};
const row = (text) => page.locator('li, tr').filter({ hasText: text }).first();

try {
  // ------------------------------------------------------------------------------------------------- sign in
  console.log('sign in');
  await page.goto(`${base}/admin/analytics`);
  await page.getByLabel('Work email').fill(info.admin.email);
  await page.getByLabel('Password', { exact: true }).fill(info.admin.password);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Authenticator code').fill(await nextCode());
  await page.getByRole('button', { name: 'Verify and continue' }).click();

  // ------------------------------------------------------------------------------------------------- overview
  console.log('overview');
  await page.getByRole('heading', { name: 'The everyday, at a glance.', level: 1 }).waitFor();
  // 2 x 690.00 + 1,790.00 + 3 x 690.00 = 5,240.00 paid in the period (the unpaid order is not counted)
  await page.getByText('₹5,240.00').first().waitFor();
  step('revenue = ₹5,240.00 (server totals, unpaid order excluded)');
  assert.equal(await page.getByRole('button', { name: /paid order/ }).count(), 30);
  await page.getByText(/Best day:/).waitFor();
  await page.getByText('Momo Steamer 2 Tier').first().waitFor();
  step('chart, top products and GST render from real data');

  // ------------------------------------------------------------------------------------------------- products
  console.log('products');
  await go('Products', 'Products');
  for (const name of Object.values(info.products)) await page.getByRole('link', { name, exact: true }).waitFor();
  await page.getByPlaceholder('Search by name or SKU').fill('kettle');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('link', { name: 'Slow Mornings Kettle' }).waitFor();
  await page.waitForFunction(() => !document.body.innerText.includes('Momo Steamer 2 Tier'));
  step('search narrows the real list');
  await page.getByPlaceholder('Search by name or SKU').fill('');
  await page.getByRole('button', { name: 'Search', exact: true }).click();

  await page.getByRole('link', { name: 'Momo Steamer 2 Tier', exact: true }).click();
  await page.getByRole('heading', { name: 'Edit product', level: 1 }).waitFor();
  await page.getByText('₹690.00 (was ₹799.00)').waitFor();
  await page.getByLabel('Product name').fill('Momo Steamer 2 Tier XL');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.getByText('Product saved.').waitFor();
  step('product rename saved');
  await page.getByRole('button', { name: /Add variant/ }).click();
  await page.getByLabel('SKU').fill('YAL-XL-30');
  await page.getByLabel('Price (₹, GST inclusive)').fill('899');
  await page.getByRole('button', { name: 'Add variant', exact: true }).last().click();
  await page.getByText('YAL-XL-30').waitFor();
  step('second variant added (price 899 -> 89,900 paise)');
  // a sale price above the price must be refused by the server rules mirrored in the form
  await page.getByRole('button', { name: 'Edit', exact: true }).last().click();
  await page.getByLabel('Sale price (₹)').last().fill('950');
  await page.getByRole('button', { name: 'Save variant' }).click();
  await page.getByRole('alert').filter({ hasText: 'sale price must be lower' }).waitFor();
  step('invalid sale price refused');

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await page.getByLabel('Alt text (describes the image)').fill('Steamer on a table');
  await page.locator('input[type=file]').setInputFiles({ name: 'steamer.png', mimeType: 'image/png', buffer: png });
  await page.locator('figure img').first().waitFor({ timeout: 15000 });
  step('image uploaded through the real multipart endpoint');

  await page.getByRole('link', { name: 'Products', exact: true }).first().click();
  await page.getByRole('heading', { name: 'Products', level: 1 }).waitFor();
  await page.getByRole('link', { name: 'Add product' }).click();
  await page.getByLabel('Product name').fill('Copper Bottle 1L');
  await page.getByLabel('Kitchen and Dining').check();
  await page.getByLabel('Brand').selectOption({ label: 'Yalli' });
  await page.getByLabel('SKU').fill('YAL-CB-1L');
  await page.getByLabel('Price (₹, GST inclusive)').fill('1299');
  await page.getByRole('button', { name: 'Create draft' }).click();
  await page.getByRole('heading', { name: 'Edit product', level: 1 }).waitFor();
  await page.getByText('draft', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await page.getByText('Product is live.').waitFor();
  const live = await (await fetch(`${BACKEND}/api/v1/catalog/products?q=Copper`)).json();
  assert.ok(live.data.some((p) => p.name === 'Copper Bottle 1L'), 'published product is visible in the public catalogue');
  step('new product created as draft, published, visible on the public storefront API');

  // ------------------------------------------------------------------------------------------------- inventory
  console.log('inventory');
  await go('Inventory', 'Inventory');
  const steamerRow = page.locator('tr').filter({ hasText: 'Momo Steamer 2 Tier XL' }).first();
  await steamerRow.waitFor();
  const onHand = async () => Number((await steamerRow.locator('td').nth(3).innerText()).trim());
  const before = await onHand();
  await steamerRow.getByRole('button', { name: 'Adjust' }).click();
  await page.getByLabel('Quantity').fill('5');
  await page.getByLabel('Reason').fill('Supplier delivery');
  await page.getByRole('button', { name: 'Save adjustment' }).click();
  await page.getByText(/stock is now \d+ on hand/).waitFor();
  await page.waitForFunction(([b]) => [...document.querySelectorAll('tr')].some((r) => r.innerText.includes('Momo Steamer 2 Tier XL') && Number(r.querySelectorAll('td')[3]?.innerText.trim()) === b + 5), [before]);
  step(`on hand ${before} -> ${before + 5}`);
  await steamerRow.getByRole('button', { name: 'Adjust' }).click();
  await page.getByRole('dialog').locator('select').nth(0).selectOption('remove');
  await page.getByLabel('Quantity').fill('99999');
  await page.getByRole('dialog').locator('select').nth(1).selectOption('ADJUSTMENT');
  await page.getByLabel('Reason').fill('Test: more than we have');
  await page.getByRole('button', { name: 'Save adjustment' }).click();
  await page.getByRole('dialog').getByRole('alert').waitFor();
  step(`overdraw refused by the server: "${(await page.getByRole('dialog').getByRole('alert').innerText()).slice(0, 80)}"`);
  await page.getByRole('button', { name: 'Cancel' }).click();
  await steamerRow.getByRole('button', { name: 'History' }).click();
  await page.getByText('Stock received').first().waitFor();
  await page.getByText('Supplier delivery').first().waitFor();
  step('ledger history shows the receipt and its reason');

  // ------------------------------------------------------------------------------------------------- orders
  console.log('orders');
  await go('Orders', 'Orders & fulfilment');
  const searchOrder = async (n) => {
    await page.getByPlaceholder('Order number or customer email').fill(n);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await page.getByRole('button', { name: n, exact: true }).click();
  };
  await searchOrder(info.orders.a);
  await page.getByText('Razorpay pay_').waitFor();
  await page.getByRole('button', { name: 'Start packing' }).click();
  await page.getByText('Order moved to packing.').waitFor();
  await page.getByLabel('Tracking number').fill('TRK-A-777');
  await page.getByRole('button', { name: 'Mark as shipped' }).click();
  await page.getByText(/marked as shipped/i).waitFor();
  await page.getByText('Delhivery · TRK-A-777').waitFor();
  step('paid -> packing -> shipped with tracking, via the real state machine');
  await page.getByLabel('Add tracking update').selectOption('OUT_FOR_DELIVERY');
  await page.getByRole('button', { name: 'Add update' }).click();
  await page.getByText('Tracking update added.').waitFor();
  await page.getByRole('button', { name: 'Mark as delivered' }).click();
  await page.getByText('Order marked as delivered.').waitFor();
  step('tracking update added, then delivered');

  await searchOrder(info.orders.d);
  await page.getByRole('button', { name: 'Cancel order…' }).click();
  await page.getByLabel('Reason (shown in the order history)').fill('Customer asked to cancel');
  await page.getByRole('button', { name: 'Confirm cancellation' }).click();
  await page.getByText('Order cancelled.').waitFor();
  await page.getByText('Cancelled', { exact: true }).first().waitFor();
  step('unpaid order cancelled');

  // ------------------------------------------------------------------------------------------------- refunds + returns
  console.log('refunds and returns');
  await go('Refunds & returns', 'Refunds & returns');
  const pending = page.locator('li').filter({ hasText: 'Two bowls arrived chipped' });
  await pending.getByRole('button', { name: 'Approve' }).click();
  await page.getByText(/Refund approved/).waitFor();
  step('refund raised by support approved by a second person');
  await page.getByRole('button', { name: 'Request a refund' }).click();
  await page.getByLabel('Find the order').fill(info.orders.c);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(info.orders.c) }).click();
  await page.getByLabel('Amount to refund').fill('150');
  await page.getByLabel('Reason', { exact: false }).fill('Goodwill for the delay');
  await page.getByRole('button', { name: 'Request refund' }).click();
  await page.getByText(/Refund requested/).waitFor();
  await page.getByText('You requested this refund, so another person must approve it.').first().waitFor();
  step('own refund request needs another approver (no approve button)');
  await page.getByRole('tab', { name: 'Return requests' }).click();
  await page.getByText('Lid is cracked', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.getByText('Return approved.').waitFor();
  await page.getByRole('button', { name: 'Goods received' }).click();
  await page.getByText(/Marked as received/).waitFor();
  step('return approved and goods received (refund created by the server)');
  await page.getByRole('tab', { name: 'Refunds' }).click();
  await page.getByText(info.orders.b).first().waitFor();

  // ------------------------------------------------------------------------------------------------- coupons
  console.log('coupons');
  await go('Coupons', 'Coupons');
  const newCoupon = async () => {
    await page.getByRole('button', { name: 'New coupon' }).click();
    await page.getByLabel('Code').fill('festive50');
    await page.getByLabel('Percentage (%)').fill('10');
    await page.getByLabel('Minimum cart value').fill('499');
  };
  await newCoupon();
  await page.getByRole('button', { name: 'Create coupon' }).click();
  await page.getByText('Coupon FESTIVE50 created.').waitFor();
  await page.getByText('FESTIVE50', { exact: true }).waitFor();
  await page.getByText('10% off').waitFor();
  await newCoupon();
  await page.getByRole('button', { name: 'Create coupon' }).click();
  await page.getByRole('alert').filter({ hasText: /already exists/i }).waitFor();
  step('coupon created; duplicate code refused by the server');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await row('FESTIVE50').getByRole('button', { name: 'Pause' }).click();
  await page.getByText(/FESTIVE50 paused/).waitFor();
  await row('FESTIVE50').getByText('Paused').waitFor();
  step('coupon paused');

  // ------------------------------------------------------------------------------------------------- shipping
  console.log('shipping');
  await go('Shipping', 'Shipping methods');
  await page.getByText(/delivery is currently free/).waitFor();
  await page.getByRole('button', { name: 'Add method' }).click();
  await page.getByLabel('Code').fill('STANDARD');
  await page.getByLabel('Name shown to customers').fill('Standard delivery');
  await page.getByLabel('Delivery fee').fill('49');
  await page.getByLabel('Free above order value').fill('499');
  await page.getByRole('button', { name: 'Add method', exact: true }).last().click();
  await page.getByText('Standard delivery added.').waitFor();
  await page.getByText(/₹49\.00 · free above ₹499\.00/).waitFor();
  assert.equal(await page.getByText(/delivery is currently free/).count(), 0);
  step('method created; "no active method" warning gone');
  const quote = await (await fetch(`${BACKEND}/api/v1/catalog/products?q=Copper`)).json();
  assert.ok(quote.success);
  await page.getByRole('button', { name: 'Turn off' }).click();
  await page.getByText('Standard delivery turned off.').waitFor();
  await page.getByText(/delivery is currently free/).waitFor();
  step('method turned off; warning back');

  // ------------------------------------------------------------------------------------------------- users
  console.log('users and roles');
  await go('Users & roles', 'Users & roles');
  await page.getByPlaceholder('Name or email').fill(info.customers.c3);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByText(info.customers.c3).waitFor();
  const c3Row = page.locator('li').filter({ hasText: info.customers.c3 });
  await c3Row.getByRole('button', { name: /Give a role/ }).click();
  await page.getByLabel('Role to give').selectOption('CUSTOMER_SUPPORT');
  await page.getByRole('button', { name: 'Give role', exact: true }).click();
  const refusal = page.getByRole('alert').filter({ hasText: /two-step verification/i });
  await refusal.waitFor();
  step(`staff role refused for a customer without MFA: "${(await refusal.innerText()).slice(0, 90)}"`);
  await page.getByPlaceholder('Name or email').fill(info.customers.c4);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByText(info.customers.c4).waitFor();
  await page.locator('li').filter({ hasText: info.customers.c4 }).getByRole('button', { name: 'Suspend…' }).click();
  await page.getByLabel('Reason for suspending').fill('Suspicious payment activity');
  await page.getByRole('button', { name: 'Suspend account' }).click();
  await page.getByText(/suspended\. Their sessions have ended/).waitFor();
  const c4Row = page.locator('li').filter({ hasText: info.customers.c4 });
  await c4Row.getByText('Suspended', { exact: true }).waitFor();
  await c4Row.getByRole('button', { name: 'Restore account' }).click();
  await page.getByText(/restored\./).waitFor();
  step('customer suspended then restored');
  await page.getByPlaceholder('Name or email').fill(info.admin.email);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  const own = page.locator('li').filter({ hasText: info.admin.email });
  await own.getByText('(you)').waitFor();
  assert.equal(await own.getByRole('button', { name: /Give a role|Suspend/ }).count(), 0, 'no role or suspend actions on your own account');

  // ------------------------------------------------------------------------------------------------- final
  console.log('overview again + phone layout');
  await go('Overview', 'The everyday, at a glance.');
  await page.getByText('₹5,240.00').first().waitFor();
  await page.setViewportSize({ width: 375, height: 800 });
  for (const [name, heading] of [['Products', 'Products'], ['Inventory', 'Inventory'], ['Orders', 'Orders & fulfilment'], ['Refunds & returns', 'Refunds & returns'], ['Coupons', 'Coupons'], ['Shipping', 'Shipping methods'], ['Users & roles', 'Users & roles']]) {
    await go(name, heading);
    await page.waitForTimeout(400);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert.ok(wide <= 1, `${name}: ${wide}px wider than the screen`);
  }
  assert.deepEqual(serverErrors, [], `5xx from the backend: ${serverErrors.join(', ')}`);
  assert.deepEqual(pageErrors, [], `uncaught page errors: ${pageErrors.join(' | ')}`);
  console.log('PASS: staff screens work against the real backend (real DB, auth, MFA, rules).');
} catch (error) {
  await page.screenshot({ path: process.env.SHOT || join(tmpdir(), 'admin-real-fail.png'), fullPage: true }).catch(() => undefined);
  console.error('URL at failure:', page.url());
  console.error('server 5xx:', serverErrors, 'page errors:', pageErrors);
  throw error;
} finally {
  await browser.close();
}
