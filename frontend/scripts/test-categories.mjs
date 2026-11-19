// Browser regression: run against a built frontend. Mock only the HTTP boundary.
// PLAYWRIGHT_MODULE may point to an existing Playwright installation.
import assert from 'node:assert/strict';
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || 'playwright'
);
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH }
    : {}),
});
const base = process.env.FRONTEND_URL || 'http://localhost:3001';
const page = await browser.newPage();
let rows = Array.from({ length: 40 }, (_, index) => ({
  id: `category-${index}`,
  name: index === 0 ? 'A'.repeat(100) : `Collection ${index}`,
  slug: `collection-${index}`,
  parentId: null,
  position: index,
  isActive: true,
  _count: { products: index === 1 ? 3 : 0, children: 0 },
}));
const envelope = (data) => ({ success: true, data });
let saved;
let deny = false;
await page.route('**/api/v1/**', async (route) => {
  const request = route.request();
  const path = new URL(request.url()).pathname.replace('/api/v1', '');
  let data;
  if (request.method() === 'OPTIONS')
    return route.fulfill({
      status: 204,
      headers: {
        'access-control-allow-origin': base,
        'access-control-allow-credentials': 'true',
        'access-control-allow-headers':
          'Authorization,Content-Type,X-Auth-Mode',
        'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      },
    });
  if (path === '/catalog/categories')
    data = rows
      .filter((row) => row.isActive)
      .map((row) => ({
        ...row,
        children: [],
        productCount: row._count.products,
      }));
  else if (path === '/auth/login')
    data = { mfaRequired: true, mfaToken: 'challenge-token' };
  else if (path === '/auth/mfa/verify')
    data = { accessToken: 'test-access-token' };
  else if (path === '/me')
    data = { email: 'admin@example.test', roles: ['ADMIN'], mfaEnabled: true };
  else if (path.startsWith('/admin/categories')) {
    assert.equal(request.headers().authorization, 'Bearer test-access-token');
    if (deny)
      return route.fulfill({
        status: 403,
        json: { success: false, message: 'Permission denied' },
        headers: {
          'access-control-allow-origin': base,
          'access-control-allow-credentials': 'true',
        },
      });
    if (request.method() === 'POST') {
      saved = request.postDataJSON();
      data = { ...saved, id: 'new', _count: { products: 0, children: 0 } };
      rows.push(data);
    } else if (request.method() === 'PATCH') {
      saved = request.postDataJSON();
      rows = rows.map((row) =>
        row.id === path.split('/').at(-1) ? { ...row, ...saved } : row,
      );
      data = saved;
    } else if (request.method() === 'DELETE') {
      rows = rows.filter((row) => row.id !== path.split('/').at(-1));
      data = null;
    } else data = rows;
  } else data = null;
  return route.fulfill({
    json: envelope(data),
    headers: {
      'access-control-allow-origin': base,
      'access-control-allow-credentials': 'true',
    },
  });
});
const overflow = async (label) => {
  const result = await page.evaluate(() => ({
    ok: document.documentElement.scrollWidth <= innerWidth,
    offenders: [...document.querySelectorAll('body *')]
      .filter((el) => el.getBoundingClientRect().right > innerWidth + 1)
      .slice(0, 12)
      .map((el) => ({
        tag: el.tagName,
        class: el.className,
        width: el.getBoundingClientRect().width,
        parent: el.parentElement?.className,
        parentWidth: el.parentElement?.getBoundingClientRect().width,
        display: getComputedStyle(el).display,
        cssWidth: getComputedStyle(el).width,
        position: getComputedStyle(el).position,
        parentDisplay: getComputedStyle(el.parentElement).display,
        parentColumns: getComputedStyle(el.parentElement).gridTemplateColumns,
      })),
  }));
  assert.equal(
    result.ok,
    true,
    `${label}: ${JSON.stringify(result.offenders)}`,
  );
};
try {
  await page.goto(`${base}/admin/categories`);
  await page.getByLabel('Work email').fill('admin@example.test');
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Authenticator code').fill('123456');
  await page.getByRole('button', { name: 'Verify and continue' }).click();
  await page
    .getByRole('heading', { name: 'Add category', exact: true })
    .waitFor();
  await page
    .getByLabel('Category name', { exact: true })
    .fill('Fresh Collection');
  await page
    .getByRole('button', { name: 'Create category', exact: true })
    .click();
  await page.getByText('Category created.', { exact: true }).waitFor();
  assert.equal(saved.slug, 'fresh-collection');
  await page
    .getByRole('button', { name: 'Edit Fresh Collection', exact: true })
    .click();
  await page
    .getByLabel('Category name', { exact: true })
    .fill('Updated Collection');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByText('Category updated.', { exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole('button', { name: 'Delete Collection 1', exact: true })
      .isDisabled(),
    true,
  );
  await page
    .getByRole('button', { name: 'Delete Updated Collection', exact: true })
    .click();
  assert.equal(
    await page.getByRole('button', { name: 'Delete permanently' }).isDisabled(),
    true,
  );
  await page
    .getByLabel('Type the category name to confirm')
    .fill('Updated Collection');
  await page.getByRole('button', { name: 'Delete permanently' }).click();
  await page.getByText('Category deleted.', { exact: true }).waitFor();
  for (const width of [320, 375, 768, 1024, 1280, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await overflow(`admin ${width}`);
  }
  deny = true;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page
    .getByRole('alert')
    .filter({ hasText: 'Permission denied' })
    .waitFor();
  deny = false;
  await page.goto(base);
  await page
    .getByRole('heading', { name: 'Find your kind of living' })
    .waitFor();
  await page
    .getByRole('link', { name: 'Collection 39', exact: true })
    .first()
    .waitFor();
  for (const width of [320, 375, 768, 1024, 1280, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await overflow(`storefront ${width}`);
    if (width < 1280) {
      await page
        .getByRole('button', { name: 'Open menu', exact: true })
        .click();
      await overflow(`open mobile menu ${width}`);
      await page
        .getByRole('button', { name: 'Close menu', exact: true })
        .click();
    } else {
      await page
        .locator('summary')
        .filter({ hasText: 'All categories' })
        .click();
      await overflow(`open desktop menu ${width}`);
      assert.equal(await page.locator('details a').count(), 40);
      await page
        .locator('summary')
        .filter({ hasText: 'All categories' })
        .click();
    }
  }
  console.log(
    'PASS: staff login + MFA, create/edit/delete confirmation, protected non-empty deletion, API denial, 40 categories, 7 viewport widths, open menus.',
  );
} finally {
  await browser.close();
}
