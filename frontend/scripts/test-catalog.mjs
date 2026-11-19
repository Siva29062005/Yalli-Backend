// Storefront catalogue regression + screenshots (Chromium via Playwright).
// Catalogue pages are server-rendered, so the API is mocked by a real HTTP server the Next server talks to.
// Usage:
//   node scripts/test-catalog.mjs --mock-api 4010         (terminal 1)
//   API_INTERNAL_URL=http://127.0.0.1:4010/api/v1 npx next start -p 3101   (terminal 2)
//   FRONTEND_URL=http://localhost:3101 node scripts/test-catalog.mjs       (terminal 3)
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync } from 'node:fs';

const img = (n) => `https://images.unsplash.com/photo-${['1556911220-e15b29be8c8f', '1544816155-12df9643f363', '1586023492125-27b2c045efd7'][n % 3]}?auto=format&fit=crop&w=800&q=80`;
const products = Array.from({ length: 30 }, (_, i) => ({
  id: `p-${i}`,
  slug: `product-${i}`,
  name: i === 0 ? 'Extra long stainless steel insulated water bottle with leak-proof lid and carry handle 1L' : `Kitchen essential ${i}`,
  summary: 'Everyday quality',
  brand: { name: i % 2 ? 'Yalli' : 'Prestige', slug: i % 2 ? 'yalli' : 'prestige' },
  price: { amountMinor: 49900 + i * 1000, compareAtMinor: i % 3 ? null : 69900 + i * 1000, onSale: i % 3 === 0, currency: 'INR' },
  inStock: i !== 4,
  imageUrl: i === 5 ? null : img(i),
  rating: i % 2 ? { average: 4.5, count: 12 } : { average: null, count: 0 },
}));
const categories = Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, name: `Collection ${i}`, slug: `collection-${i}`, productCount: 3, children: [] }));
const detail = (slug) => {
  const s = products.find((p) => p.slug === slug);
  if (!s) return null;
  return {
    ...s,
    descriptionHtml: '<p>Built to last, with <strong>food-grade</strong> steel.</p>',
    categories: [{ name: 'Collection 1', slug: 'collection-1' }],
    tags: [],
    attributes: [{ name: 'Material', value: 'Stainless steel' }, { name: 'Capacity', value: '1 L' }],
    images: [{ url: img(0), altText: null, variantId: null }, { url: img(1), altText: null, variantId: null }],
    gstRateBps: 1800,
    variants: [
      { id: 'v1', sku: 'SKU-1', name: '500 ml', optionValues: null, price: s.price, inStock: true, lowStock: true },
      { id: 'v2', sku: 'SKU-2', name: '1 L', optionValues: null, price: { ...s.price, amountMinor: s.price.amountMinor + 20000 }, inStock: false, lowStock: false },
    ],
  };
};

function mockApi(port) {
  http
    .createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      const path = url.pathname.replace('/api/v1', '');
      const send = (status, data, meta = null) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(status < 400 ? { success: true, data, meta } : { success: false, message: 'Product not found' }));
      };
      if (path === '/catalog/products') {
        let list = products;
        const q = url.searchParams.get('q');
        if (q) list = list.filter((p) => p.name.toLowerCase().includes(q.toLowerCase()));
        if (url.searchParams.get('brand')) list = list.filter((p) => p.brand.slug === url.searchParams.get('brand'));
        if (url.searchParams.get('inStock')) list = list.filter((p) => p.inStock);
        if (url.searchParams.get('sort') === 'price_desc') list = [...list].sort((a, b) => b.price.amountMinor - a.price.amountMinor);
        const page = Number(url.searchParams.get('page') || 1);
        const size = Number(url.searchParams.get('pageSize') || 20);
        return send(200, list.slice((page - 1) * size, page * size), { page, pageSize: size, total: list.length, totalPages: Math.ceil(list.length / size) });
      }
      if (path === '/catalog/categories') return send(200, categories);
      if (path === '/catalog/brands') return send(200, [{ name: 'Prestige', slug: 'prestige', productCount: 15 }, { name: 'Yalli', slug: 'yalli', productCount: 15 }]);
      let m = path.match(/^\/catalog\/products\/([^/]+)\/reviews\/summary$/);
      if (m) return send(200, { count: 2, average: 4.5, distribution: { 1: 0, 2: 0, 3: 0, 4: 1, 5: 1 } });
      m = path.match(/^\/catalog\/products\/([^/]+)\/reviews$/);
      if (m) return send(200, [{ id: 'r1', rating: 5, title: 'Great', body: 'Keeps water cold all day.', verifiedPurchase: true, reviewer: 'Pooja M.', createdAt: '2026-11-10T00:00:00Z' }]);
      m = path.match(/^\/catalog\/products\/([^/]+)$/);
      if (m) {
        const d = detail(m[1]);
        return d ? send(200, d) : send(404);
      }
      return send(404);
    })
    .listen(port, '127.0.0.1', () => console.log(`mock API on ${port}`));
}

if (process.argv[2] === '--mock-api') {
  mockApi(Number(process.argv[3] || 4010));
} else {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const base = process.env.FRONTEND_URL || 'http://localhost:3101';
  const out = process.env.SCREENSHOT_DIR || 'screenshots';
  mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

  // Listing: server-side pagination, 24 per page.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${base}/catalog`, { waitUntil: 'load' });
  await page.locator('article').first().waitFor();
  assert.equal(await page.locator('article:visible').count(), 24);
  assert.match(await page.locator('[aria-live=polite]').first().innerText(), /30\s+products/);
  await page.screenshot({ path: `${out}/catalog-desktop.png`, fullPage: true });

  await page.getByRole('link', { name: '2', exact: true }).click();
  await page.waitForURL(/page=2/);
  assert.equal(await page.locator('article:visible').count(), 6);

  // Filters are URL-driven.
  await page.goto(`${base}/catalog?brand=yalli`, { waitUntil: 'load' });
  assert.match(await page.locator('[aria-live=polite]').first().innerText(), /15\s+products/);
  await page.getByRole('searchbox', { name: 'Search products' }).fill('essential 1');
  await page.getByRole('searchbox', { name: 'Search products' }).press('Enter');
  await page.waitForURL(/q=essential/);
  assert.ok((await page.locator('article:visible').count()) > 0);

  // Empty + invalid params do not crash.
  await page.goto(`${base}/catalog?q=zzzz&page=-3&sort=hack&min=abc`, { waitUntil: 'load' });
  await page.locator('main:visible').getByText('No products match your filters.').first().waitFor();

  // Product detail.
  await page.goto(`${base}/products/product-0`, { waitUntil: 'load' });
  await page.locator('main:visible').getByRole('heading', { level: 1 }).waitFor();
  await page.locator('main:visible').getByText('Only a few left').first().waitFor();
  await page.locator('main:visible').getByRole('button', { name: '1 L' }).click();
  assert.equal(await page.locator('main:visible').getByRole('button', { name: 'Out of stock' }).isDisabled(), true);
  await page.screenshot({ path: `${out}/product-desktop.png`, fullPage: true });

  const res = await page.goto(`${base}/products/does-not-exist`);
  assert.equal(res.status(), 404);
  await page.locator('main:visible').getByText('This product isn’t available').first().waitFor();

  // No horizontal overflow at any width.
  for (const width of [320, 375, 768, 1024, 1280, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of ['/catalog', '/products/product-0', '/']) {
      await page.goto(`${base}${path}`, { waitUntil: 'load' });
      assert.ok((await overflow()) <= 0, `overflow on ${path} at ${width}px`);
    }
  }
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`${base}/catalog`, { waitUntil: 'load' });
  await page.screenshot({ path: `${out}/catalog-mobile.png`, fullPage: true });
  await page.getByRole('button', { name: 'Filters' }).click();
  await page.screenshot({ path: `${out}/catalog-mobile-filters.png` });
  await page.goto(`${base}/products/product-0`, { waitUntil: 'load' });
  await page.screenshot({ path: `${out}/product-mobile.png`, fullPage: true });

  await browser.close();
  console.log('catalog tests passed; screenshots in', out);
}
