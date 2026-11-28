import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
const base = process.env.FRONTEND_URL || 'http://localhost:3001';
const page = await browser.newPage();
let mode = 'staff';
let expired = false;
const authModes = new Set(); // X-Auth-Mode on the console's sign-in calls: always its own cookie pair
await page.route('**/api/v1/**', async (route) => {
  const request = route.request();
  const path = new URL(request.url()).pathname.replace('/api/v1', '');
  const headers = { 'access-control-allow-origin': base, 'access-control-allow-credentials': 'true', 'access-control-allow-headers': 'Authorization,Content-Type,X-Auth-Mode', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
  if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
  if (expired && path === '/admin/categories') return route.fulfill({ status: 401, headers, json: { success: false, message: 'Authentication required', error: { code: 'ACCESS_TOKEN_INVALID' } } });
  let data = [];
  if (path === '/auth/login' || path === '/auth/mfa/verify' || path === '/auth/refresh' || path === '/auth/logout') authModes.add(request.headers()['x-auth-mode'] ?? 'none');
  if (path === '/auth/login') data = mode === 'no-mfa' ? { mfaRequired: false, accessToken: 'test-token' } : { mfaRequired: true, mfaToken: 'challenge' };
  if (path === '/auth/mfa/verify') data = { accessToken: 'test-token' };
  if (path === '/me') data = { email: 'staff@example.test', roles: [mode === 'customer' ? 'CUSTOMER' : 'ADMIN'], mfaEnabled: true };
  return route.fulfill({ headers, json: { success: true, data } });
});
async function password() {
  await page.getByLabel('Work email').fill('staff@example.test');
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
}
async function otp() {
  await page.getByLabel('Authenticator code').fill('123456');
  await page.getByRole('button', { name: 'Verify and continue', exact: true }).click();
}
try {
  for (const path of ['analytics', 'products', 'products/new', 'categories', 'brands', 'import', 'inventory', 'orders', 'refunds', 'finance', 'customers', 'messages', 'reviews', 'users', 'audit', 'coupons', 'shipping']) {
    await page.goto(`${base}/admin/${path}`);
    await page.getByRole('heading', { name: 'Secure admin sign in' }).waitFor();
    assert.equal(await page.locator('aside').count(), 0, `${path} exposed admin sidebar`);
    assert.equal(await page.getByLabel('Password', { exact: true }).count(), 1);
  }
  mode = 'no-mfa';
  await password();
  await page.getByRole('alert').filter({ hasText: 'MFA enabled' }).waitFor();
  mode = 'customer';
  await password();
  await otp();
  await page.getByRole('alert').filter({ hasText: 'does not have staff access' }).waitFor();
  await page.getByRole('button', { name: 'Start again' }).click();
  mode = 'staff';
  await password();
  assert.equal(await page.locator('aside').count(), 0, 'Password alone unlocked admin');
  await otp();
  await page.getByRole('link', { name: 'Categories', exact: true }).click();
  await page.getByRole('heading', { name: 'Add category', exact: true }).waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((button) => button.textContent.trim() === 'Refresh' && !button.disabled));
  expired = true;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByLabel('Password', { exact: true }).waitFor();
  assert.equal(await page.locator('aside').count(), 0);
  expired = false;
  await password();
  await otp();
  await page.getByRole('button', { name: 'Sign out of admin' }).click();
  await page.getByLabel('Password', { exact: true }).waitFor();
  await page.reload();
  await page.getByLabel('Password', { exact: true }).waitFor();
  await page.goto(base);
  assert.equal(await page.locator('a[href^="/admin"]').count(), 0);
  await page.setViewportSize({ width: 375, height: 900 });
  await page.getByRole('button', { name: 'Open menu', exact: true }).click();
  assert.equal(await page.locator('a[href^="/admin"]').count(), 0);
  assert.deepEqual([...authModes], ['cookie-admin'], 'the console signs in and out with its own cookie pair (X-Auth-Mode: cookie-admin)');
  console.log('PASS: all 11 admin screens locked, password + MFA required, customers rejected, session expiry and sign-out lock workspace, no public admin links.');
} finally {
  await browser.close();
}
