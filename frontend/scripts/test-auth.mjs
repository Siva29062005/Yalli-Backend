// Customer auth regression + screenshots (Chromium via Playwright). API calls are intercepted in the browser.
// Usage: FRONTEND_URL=http://localhost:3101 PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/test-auth.mjs
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const BASE = process.env.FRONTEND_URL || 'http://localhost:3101';
const SHOTS = '/tmp/yalli-shots/auth';
mkdirSync(SHOTS, { recursive: true });

const me = {
  id: 'u1', email: 'priya.k@example.com', phone: '+919876543210', emailVerified: true, phoneVerified: false,
  mfaEnabled: false, firstName: 'Priya', lastName: 'Kumar', newsletterSubscribed: false, roles: ['CUSTOMER'], createdAt: '2026-01-01',
};
const ok = (data) => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data }) });
const fail = (status, message, code, details) => ({
  status, contentType: 'application/json', body: JSON.stringify({ success: false, message, error: { code, details } }),
});

async function setup(context, overrides = {}) {
  const calls = [];
  let signedIn = false;
  await context.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace('/api/v1', '');
    const body = req.postDataJSON?.() ?? null;
    calls.push({ path, method: req.method(), body, headers: req.headers() });
    if (overrides[path]) return route.fulfill(await overrides[path](body, req));
    if (path === '/catalog/categories') return route.fulfill(ok([]));
    if (path === '/auth/login') {
      if (body.password !== 'correct horse battery') return route.fulfill(fail(401, 'Invalid email or password', 'UNAUTHORIZED'));
      signedIn = true;
      return route.fulfill(ok({ mfaRequired: false, accessToken: 'at-1', csrfToken: 'csrf-1' }));
    }
    if (path === '/auth/refresh') {
      if (!signedIn || req.headers()['x-csrf-token'] !== 'csrf-1') return route.fulfill(fail(401, 'Session expired', 'UNAUTHORIZED'));
      return route.fulfill(ok({ accessToken: 'at-2', csrfToken: 'csrf-1' }));
    }
    if (path === '/me') {
      return route.fulfill(req.headers().authorization ? ok(me) : fail(401, 'Unauthorized', 'UNAUTHORIZED'));
    }
    if (path === '/auth/logout') {
      signedIn = false;
      return route.fulfill(ok(null));
    }
    return route.fulfill(ok(null));
  });
  return calls;
}

const browser = await chromium.launch();
let passed = 0;
const test = async (name, fn) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    await fn(context);
    passed++;
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

await test('visitors are anonymous by default and account pages redirect to login', async (context) => {
  await setup(context);
  const page = await context.newPage();
  await page.goto(`${BASE}/account/orders?tab=open`);
  await page.waitForURL(/\/auth\/login\?next=/);
  assert.equal(new URL(page.url()).searchParams.get('next'), '/account/orders?tab=open');
  assert.equal(await page.locator('header a[aria-label="Sign in"]').count(), 1);
  await page.screenshot({ path: `${SHOTS}/login-desktop.png`, fullPage: true });
});

await test('wrong password shows the server error; correct password signs in and honours next', async (context) => {
  const calls = await setup(context);
  const page = await context.newPage();
  await page.goto(`${BASE}/auth/login?next=/account/orders`);
  await page.fill('#email', 'priya.k@example.com');
  await page.fill('#password', 'wrong password!!');
  await page.click('button[type=submit]');
  await page.getByRole('alert').getByText('Invalid email or password').waitFor();
  await page.fill('#password', 'correct horse battery');
  await page.click('button[type=submit]');
  await page.waitForURL(`${BASE}/account/orders`);
  const login = calls.find((c) => c.path === '/auth/login' && c.body.password === 'correct horse battery');
  assert.equal(login.headers['x-auth-mode'], 'cookie');
  await page.locator('aside').getByText('Priya Kumar').waitFor();
  // Reload restores the session via the refresh cookie.
  await page.reload();
  await page.locator('aside').getByText('Priya Kumar').waitFor();
  assert.ok(calls.some((c) => c.path === '/auth/refresh' && c.headers['x-csrf-token'] === 'csrf-1'));
  // Log out clears the session.
  await page.getByRole('button', { name: /log out/i }).click();
  await page.waitForURL(`${BASE}/`);
  assert.equal(await page.evaluate(() => localStorage.getItem('yalli_customer_csrf')), null);
  await page.goto(`${BASE}/account/profile`);
  await page.waitForURL(/\/auth\/login/);
});

await test('open redirects are rejected', async (context) => {
  await setup(context);
  const page = await context.newPage();
  await page.goto(`${BASE}/auth/login?next=//evil.example/steal`);
  await page.fill('#email', 'priya.k@example.com');
  await page.fill('#password', 'correct horse battery');
  await page.click('button[type=submit]');
  await page.waitForURL(`${BASE}/account/profile`);
});

await test('MFA challenge, recovery code toggle and verification', async (context) => {
  const calls = await setup(context, {
    '/auth/login': () => ok({ mfaRequired: true, mfaToken: 'mfa-token-xxxxxxxxxxxxxxxx' }),
    '/auth/mfa/verify': (body) =>
      body.code === '123456' ? ok({ accessToken: 'at-1', csrfToken: 'csrf-1' }) : fail(401, 'The code is incorrect or expired', 'UNAUTHORIZED'),
  });
  const page = await context.newPage();
  await page.goto(`${BASE}/auth/login`);
  await page.fill('#email', 'priya.k@example.com');
  await page.fill('#password', 'anything goes here');
  await page.click('button[type=submit]');
  await page.locator('#mfa-code').waitFor();
  await page.screenshot({ path: `${SHOTS}/mfa.png` });
  await page.getByRole('button', { name: 'Use a recovery code' }).click();
  await page.getByText('Recovery code', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Use authenticator code' }).click();
  await page.fill('#mfa-code', '12ab');
  assert.equal(await page.inputValue('#mfa-code'), '12', 'non-digits are stripped');
  await page.fill('#mfa-code', '123456');
  await page.click('button[type=submit]');
  await page.waitForURL(`${BASE}/account/profile`);
  assert.equal(calls.find((c) => c.path === '/auth/mfa/verify').body.mfaToken, 'mfa-token-xxxxxxxxxxxxxxxx');
});

await test('unverified email offers to resend', async (context) => {
  const calls = await setup(context, {
    '/auth/login': () => fail(403, 'Please verify your email address to sign in', 'EMAIL_NOT_VERIFIED'),
  });
  const page = await context.newPage();
  await page.goto(`${BASE}/auth/login`);
  await page.fill('#email', 'priya.k@example.com');
  await page.fill('#password', 'correct horse battery');
  await page.click('button[type=submit]');
  await page.getByRole('button', { name: 'Resend verification email' }).click();
  await page.getByText(/new verification email is on its way/).waitFor();
  assert.ok(calls.some((c) => c.path === '/auth/resend-verification'));
});

await test('registration validates locally, maps server field errors, then confirms', async (context) => {
  let attempt = 0;
  const calls = await setup(context, {
    '/auth/register': () =>
      ++attempt === 1
        ? fail(400, 'This password has appeared in a data breach.', 'VALIDATION_FAILED', [{ path: 'password', message: 'has appeared in a known data breach' }])
        : { status: 202, contentType: 'application/json', body: JSON.stringify({ success: true, data: null }) },
  });
  const page = await context.newPage();
  await page.goto(`${BASE}/auth/register`);
  await page.click('button[type=submit]');
  await page.getByText('Enter your first name').waitFor();
  await page.getByText('Please accept the Privacy Policy to continue').waitFor();
  assert.equal(calls.filter((c) => c.path === '/auth/register').length, 0);
  await page.fill('#firstName', 'Priya');
  await page.fill('#lastName', 'Kumar');
  await page.fill('#email', 'priya.k@example.com');
  await page.fill('#phone', '98765 43210');
  await page.fill('#password', 'priyasecret-123');
  await page.check('#acceptPrivacyPolicy');
  await page.click('button[type=submit]');
  await page.getByText("Don't include your email name").waitFor();
  await page.fill('#password', 'blue mango sunrise 42');
  await page.click('button[type=submit]');
  await page.getByText('Password has appeared in a known data breach').waitFor();
  await page.screenshot({ path: `${SHOTS}/register-error.png`, fullPage: true });
  await page.fill('#password', 'blue mango sunrise 43');
  await page.click('button[type=submit]');
  await page.getByRole('heading', { name: 'Check your inbox.' }).waitFor();
  const body = calls.filter((c) => c.path === '/auth/register').at(-1).body;
  assert.deepEqual(Object.keys(body).sort(), ['acceptPrivacyPolicy', 'email', 'firstName', 'lastName', 'newsletter', 'password', 'phone']);
});

await test('email verification link, expired link and short email paths', async (context) => {
  await setup(context, {
    '/auth/verify-email': (body) =>
      body.token === 'good-token-aaaaaaaaaaaaaaaa' ? ok(null) : fail(400, 'This link is invalid or has expired', 'BAD_REQUEST'),
  });
  const page = await context.newPage();
  await page.goto(`${BASE}/verify-email?token=good-token-aaaaaaaaaaaaaaaa`);
  await page.waitForURL(/\/auth\/verify-email\?token=/);
  await page.getByRole('heading', { name: /all set/ }).waitFor();
  await page.goto(`${BASE}/auth/verify-email?token=bad-token-aaaaaaaaaaaaaaaaa`);
  await page.getByRole('heading', { name: 'This link has expired' }).waitFor();
});

await test('forgot and reset password', async (context) => {
  const calls = await setup(context);
  const page = await context.newPage();
  await page.goto(`${BASE}/auth/reset-password`);
  await page.fill('#email', 'priya.k@example.com');
  await page.click('button[type=submit]');
  await page.getByText(/reset link shortly/).waitFor();
  await page.goto(`${BASE}/reset-password?token=reset-token-aaaaaaaaaaaaaa`);
  await page.fill('#new-password', 'blue mango sunrise 42');
  await page.fill('#confirm-password', 'blue mango sunrise 41');
  await page.click('button[type=submit]');
  await page.getByText('The passwords do not match').waitFor();
  await page.fill('#confirm-password', 'blue mango sunrise 42');
  await page.click('button[type=submit]');
  await page.waitForURL(/\/auth\/login\?reset=1/);
  await page.getByText(/password was updated/).waitFor();
  assert.deepEqual(calls.find((c) => c.path === '/auth/reset-password').body, {
    token: 'reset-token-aaaaaaaaaaaaaa', newPassword: 'blue mango sunrise 42',
  });
});

await test('no horizontal overflow on auth pages', async () => {
  for (const width of [320, 375, 768, 1024, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await setup(context);
    const page = await context.newPage();
    for (const path of ['/auth/login', '/auth/register', '/auth/reset-password', '/auth/verify-email']) {
      await page.goto(`${BASE}${path}`);
      await page.locator('h1').first().waitFor();
      await noOverflow(page);
      if (width === 375) await page.screenshot({ path: `${SHOTS}/mobile${path.replaceAll('/', '-')}.png`, fullPage: true });
    }
    await context.close();
  }
});

await browser.close();
console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}. Screenshots in ${SHOTS}`);
