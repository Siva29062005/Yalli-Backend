// SEO regression over plain HTTP (no browser): robots.txt, sitemap.xml, canonical links, noindex rules, structured data.
// The storefront must be BUILT with NEXT_PUBLIC_BUSINESS_WEBSITE_URL=https://shop.example.test and started against the
// catalogue mock API (see test-catalog.mjs):
//   node scripts/test-catalog.mjs --mock-api 4011 &
//   NEXT_PUBLIC_BUSINESS_WEBSITE_URL=https://shop.example.test npm run build
//   API_INTERNAL_URL=http://127.0.0.1:4011/api/v1 npx next start -p 3199 &
//   MOCK_API=http://127.0.0.1:4011/api/v1 FRONTEND_URL=http://localhost:3199 node scripts/test-seo.mjs
// Optional: DEAD_API_FRONTEND_URL = a second `next start` whose API_INTERNAL_URL points at nothing (outage check).
import assert from 'node:assert/strict';

const BASE = process.env.FRONTEND_URL || 'http://localhost:3199';
const MOCK = process.env.MOCK_API || 'http://127.0.0.1:4011/api/v1';
const SITE = process.env.SITE_URL || 'https://shop.example.test';
const text = async (path, base = BASE) => {
  const res = await fetch(`${base}${path}`, { redirect: 'manual' });
  return { status: res.status, headers: res.headers, body: await res.text() };
};
const ok = (m) => console.log(`PASS ${m}`);

const products = (await (await fetch(`${MOCK}/catalog/products?pageSize=60`)).json()).data;
assert.ok(products.length > 0, 'the mock API must serve products');
const slug = products[0].slug;

// robots.txt
const robots = await text('/robots.txt');
assert.equal(robots.status, 200);
for (const p of ['/admin', '/account', '/cart', '/checkout', '/auth', '/orders', '/compare'])
  assert.match(robots.body, new RegExp(`Disallow: ${p}\\b`), `robots.txt disallows ${p}`);
assert.match(robots.body, new RegExp(`Sitemap: ${SITE}/sitemap.xml`));
ok('robots.txt disallows private areas and names the sitemap');

// sitemap.xml
const sitemap = await text('/sitemap.xml');
assert.equal(sitemap.status, 200);
assert.match(sitemap.headers.get('content-type') ?? '', /xml/);
assert.match(sitemap.body, /<urlset/);
const locs = [...sitemap.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
for (const path of ['', '/catalog', '/help', '/shipping', '/returns', '/privacy', '/terms', '/contact'])
  assert.ok(locs.includes(`${SITE}${path}`), `sitemap lists ${path || '/'}`);
for (const p of products) assert.ok(locs.includes(`${SITE}/products/${p.slug}`), `sitemap lists product ${p.slug}`);
assert.ok(locs.some((l) => l.startsWith(`${SITE}/catalog/`)), 'sitemap lists categories');
assert.equal(locs.some((l) => /\/(admin|account|cart|checkout|auth|orders|compare)(\/|$)/.test(l)), false, 'no private URLs');
assert.equal(new Set(locs).size, locs.length, 'no duplicates');
ok(`sitemap lists ${locs.length} URLs: static pages, categories, every product; none private`);

// product page: canonical + Product structured data
const page = await text(`/products/${slug}`);
assert.equal(page.status, 200);
assert.match(page.body, new RegExp(`<link rel="canonical" href="${SITE}/products/${slug}"`));
const ld = [...page.body.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
const product = ld.find((d) => d['@type'] === 'Product');
assert.ok(product, 'product page has Product JSON-LD');
assert.equal(product.name, products[0].name);
const offer = product.offers;
const expected = `${Math.floor(products[0].price.amountMinor / 100)}.${String(products[0].price.amountMinor % 100).padStart(2, '0')}`;
assert.ok(offer.price === expected || offer.lowPrice !== undefined, `price ${expected} comes from the server price`);
assert.equal(offer.priceCurrency, 'INR');
assert.match(offer.availability, /schema\.org\/(InStock|OutOfStock)/);
ok('product page: canonical link and Product structured data with the server price in INR');

// home: WebSite structured data + canonical
const home = await text('/');
assert.match(home.body, new RegExp(`<link rel="canonical" href="${SITE}"`));
assert.ok([...home.body.matchAll(/application\/ld\+json">([\s\S]*?)<\/script>/g)].some((m) => JSON.parse(m[1])['@type'] === 'WebSite'));
ok('home: canonical and WebSite search structured data');
// The home page makes no promise the shop does not keep (CLAUDE.md, Phase 9).
for (const claim of [/WELCOME100/, /replacement/i, /Free shipping above/i, /WhatsApp/i, /Ananya/, /catalog\/tablet/, /Save up to \d+%/])
  assert.doesNotMatch(home.body, claim, `home page must not claim ${claim}`);
assert.match(home.body, /href="\/returns"/);
ok('home: no invented offers, coupons, testimonials, fees or support channels');

// listings: plain page indexed, filtered/search/paged pages are not
const plain = await text('/catalog');
assert.match(plain.body, new RegExp(`<link rel="canonical" href="${SITE}/catalog"`));
assert.doesNotMatch(plain.body, /<meta name="robots" content="noindex/);
for (const q of ['?q=steamer', '?sort=price_asc', '?page=2', '?brand=yalli']) {
  const r = await text(`/catalog${q}`);
  assert.match(r.body, /<meta name="robots" content="noindex, follow"/, `/catalog${q} is noindex,follow`);
  assert.match(r.body, new RegExp(`<link rel="canonical" href="${SITE}/catalog"`), `/catalog${q} canonicalises to /catalog`);
}
ok('catalogue: plain listing indexable; search, filters and paging noindex with a canonical');

// categories (Phase 10): server-rendered names and links, a real 404 for unknown ones, "all products" goes to /catalog
const cat = await text('/catalog/collection-3');
assert.equal(cat.status, 200);
assert.match(cat.body, /<h1[^>]*>[^<]*Collection 3/, 'the category name is in the server HTML heading');
assert.match(cat.body, /href="\/catalog\/collection-0"/, 'category links are in the server HTML (nav/footer)');
assert.doesNotMatch(cat.body, /href="\/catalog\/all-products"/, 'no link to the placeholder "all products" category');
assert.equal((await text('/catalog/no-such-category')).status, 404, 'unknown category is a 404');
const all = await text('/catalog/all-products');
assert.ok([307, 308].includes(all.status) && /\/catalog$/.test(all.headers.get('location') ?? ''), 'all-products redirects to /catalog');
ok('categories: names and links in the server HTML, unknown category 404, all-products redirects');

// brands and specials (Phase 10)
const brands = await text('/brands');
assert.equal(brands.status, 200);
assert.match(brands.body, /href="\/brands\/yalli"/);
const brandPage = await text('/brands/yalli');
assert.equal(brandPage.status, 200);
assert.match(brandPage.body, /<h1[^>]*>[^<]*Yalli/);
assert.match(brandPage.body, new RegExp(`<link rel="canonical" href="${SITE}/brands/yalli"`));
assert.equal((await text('/brands/no-such-brand')).status, 404, 'unknown brand is a 404');
const specials = await text('/specials');
assert.equal(specials.status, 200);
assert.match(specials.body, /<h1[^>]*>On sale/);
const map = (await text('/sitemap.xml')).body;
for (const loc of ['/specials', '/brands', '/brands/yalli']) assert.ok(map.includes(`<loc>${SITE}${loc}</loc>`), `sitemap lists ${loc}`);
ok('brands and specials pages: listed, canonical, unknown brand 404, in the sitemap');

// policy pages
for (const p of ['help', 'shipping', 'returns', 'privacy', 'terms', 'contact'])
  assert.match((await text(`/${p}`)).body, new RegExp(`<link rel="canonical" href="${SITE}/${p}"`), `${p} canonical`);
ok('policy pages have canonical links');

// private areas: X-Robots-Tag header
for (const p of ['/cart', '/checkout', '/account/orders', '/auth/login', '/admin/orders', '/compare'])
  assert.match((await text(p)).headers.get('x-robots-tag') ?? '', /noindex/, `${p} sends X-Robots-Tag noindex`);
ok('private areas send X-Robots-Tag: noindex, nofollow');

// security headers on every page (next.config.ts)
for (const p of ['/', '/products/' + slug, '/checkout', '/admin/orders']) {
  const h = (await text(p)).headers;
  const csp = h.get('content-security-policy') ?? '';
  assert.match(csp, /default-src 'self'/, `${p} has a CSP`);
  assert.match(csp, /frame-ancestors 'none'/, `${p} cannot be framed`);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /script-src 'self' 'unsafe-inline' https:\/\/\*\.razorpay\.com https:\/\/challenges\.cloudflare\.com/);
  assert.doesNotMatch(csp, /unsafe-eval/, 'no unsafe-eval in a production build');
  assert.equal(h.get('x-frame-options'), 'DENY');
  assert.equal(h.get('x-content-type-options'), 'nosniff');
  assert.equal(h.get('x-powered-by'), null);
}
assert.equal((await text('/auth/reset-password')).headers.get('referrer-policy'), 'no-referrer', 'auth pages send no referrer');
assert.equal((await text('/')).headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
ok('security headers: CSP, no framing, nosniff, no-referrer on sign-in and reset pages');

// API outage: the sitemap still answers with the static pages
if (process.env.DEAD_API_FRONTEND_URL) {
  const dead = await text('/sitemap.xml', process.env.DEAD_API_FRONTEND_URL);
  assert.equal(dead.status, 200, 'sitemap survives an API outage');
  assert.match(dead.body, new RegExp(`<loc>${SITE}/help</loc>`));
  assert.doesNotMatch(dead.body, /\/products\//);
  ok('API outage: sitemap still lists the static pages (no 500)');
}
console.log('PASS: SEO');
