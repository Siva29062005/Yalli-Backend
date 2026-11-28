import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import converted from '../data/legacy-redirects.json';
import extra from '../data/legacy-redirects-extra.json';
import { RESERVED_SEGMENTS, buildLegacyMap, isSafeTarget, legacyRedirect, normalizeQuery } from './legacy-redirects';

// the converter's output format (migration/redirects.json)
const entries = [
  { kind: 'product', id: '42', keyword: '3in1MomosMakerMachine', to: '/products/3in1momosmakermachine' },
  { kind: 'product', id: '45', keyword: null, to: '/products/night-lamp' },
  { kind: 'category', id: '20', keyword: 'kitchen-dining', to: '/catalog/kitchen-dining' },
  { kind: 'category', id: '20_27', keyword: 'cookware', to: '/catalog/cookware' },
  { kind: 'category', id: '33', keyword: 'desktops/mac', to: '/catalog/mac' },
  { kind: 'brand', id: '5', keyword: 'yalli-brand', to: '/brands/yalli' },
];
const handWritten = [{ kind: 'information', id: '4', keyword: 'about-yalli', to: '/help' }];
const map = buildLegacyMap(entries, handWritten);
const go = (path: string, query = '') =>
  legacyRedirect(path, normalizeQuery(new URLSearchParams(query).entries()), map);

describe('old OpenCart addresses', () => {
  it.each([
    ['product/product&product_id=42', '/products/3in1momosmakermachine'],
    ['product/product&path=20_27&product_id=45', '/products/night-lamp'],
    ['product/product&product_id=042', '/products/3in1momosmakermachine'], // OpenCart casts ids to numbers
    ['product/product&amp;product_id=42', '/products/3in1momosmakermachine'], // &amp; in feeds and exports
    ['product/product&product_id=1&product_id=42', '/products/3in1momosmakermachine'], // PHP: the last value wins
    ['product/category&path=20', '/catalog/kitchen-dining'],
    ['product/category&amp;path=20', '/catalog/kitchen-dining'],
    ['product/category&path=20_27', '/catalog/cookware'],
    ['product/category&path=99_27', '/catalog/cookware'], // by the category's own id
    ['product/category', '/catalog'],
    ['product/manufacturer.info&manufacturer_id=5', '/brands/yalli'],
    ['product/manufacturer|info&manufacturer_id=5', '/brands/yalli'], // OpenCart 4.0.0/4.0.1
    ['product/manufacturer', '/brands'],
    ['information/information&information_id=4', '/help'], // the hand-written entry wins over the default
    ['information/information&information_id=6', '/shipping'], // default
    ['product/special', '/specials'],
    ['product/search&search=steel bottle', '/catalog?q=steel%20bottle'],
    ['product/search&tag=lamp', '/catalog?q=lamp'],
    ['common/home', '/'],
    ['account/login', '/auth/login'],
    ['account/order/info&order_id=7', '/account/orders'],
    ['account/order.info&order_id=7', '/account/orders'],
    ['checkout/cart', '/cart'],
    ['extension/feed/google_sitemap', '/sitemap.xml'],
    ['PRODUCT/PRODUCT&product_id=42', '/products/3in1momosmakermachine'],
  ])('index.php?route=%s -> %s', (query, to) => {
    expect(go('/index.php', `route=${query}`)).toBe(to);
  });

  it('sends a bare /index.php home and reads OpenCart 3 rewrite targets', () => {
    expect(go('/index.php')).toBe('/');
    expect(go('/index.php', '_route_=kitchen-dining/3in1momosmakermachine')).toBe('/products/3in1momosmakermachine');
  });

  it('keeps whole characters in an old search (an emoji cut in half must not throw)', () => {
    const to = go('/index.php', `route=product/search&search=a${'😀'.repeat(150)}`);
    expect(to).toMatch(/^\/catalog\?q=a/);
    expect(Array.from(decodeURIComponent(to!.slice('/catalog?q='.length)))).toHaveLength(100);
  });

  it.each([
    ['/3in1MomosMakerMachine', '/products/3in1momosmakermachine'],
    ['/kitchen-dining/3in1momosmakermachine', '/products/3in1momosmakermachine'],
    ['/kitchen-dining', '/catalog/kitchen-dining'],
    ['/kitchen-dining/', '/catalog/kitchen-dining'],
    ['/kitchen-dining/cookware', '/catalog/cookware'],
    ['/en-gb/product/3in1momosmakermachine', '/products/3in1momosmakermachine'],
    ['/en-gb/catalog/desktops/mac', '/catalog/mac'],
    ['/3in1momosmakermachine.html', '/products/3in1momosmakermachine'],
    ['/yalli-brand', '/brands/yalli'],
    ['/delivery', '/shipping'],
    ['/%33in1momosmakermachine', '/products/3in1momosmakermachine'],
  ])('SEO address %s -> %s', (path, to) => {
    expect(go(path)).toBe(to);
  });

  it('OpenCart routes on the language path and on the home page', () => {
    expect(go('/en-gb', 'route=product/product&product_id=42')).toBe('/products/3in1momosmakermachine');
    expect(go('/', 'route=product/product&product_id=42')).toBe('/products/3in1momosmakermachine');
    expect(go('/')).toBeNull(); // the home page itself
  });

  it.each([
    ['/index.php', 'route=product/product&product_id=999'],
    ['/index.php', 'route=product/product&product_id=42abc'],
    ['/index.php', 'route=product/product'],
    ['/index.php', 'route=product/category&path=20_'],
    ['/index.php', 'route=extension/payment/whatever'],
    ['/index.php', 'route=constructor'], // no prototype keys
    ['/index.php', 'route=__proto__'],
    ['/index.php', 'route=toString'],
    ['/no-such-page', ''],
    ['/a/b/c/d/e/f/g/h/i', ''],
    ['/%ZZ', ''], // malformed percent-encoding: the normal 404, not a crash
  ])('unknown %s?%s goes on to the 404', (path, query) => {
    expect(go(path, query)).toBeNull();
  });

  it('never touches pages of this shop or files, even when an old keyword has the same name', () => {
    const clash = buildLegacyMap([
      { kind: 'category', id: '1', keyword: 'brands', to: '/catalog/brands-old' },
      { kind: 'category', id: '2', keyword: 'kitchen-dining', to: '/catalog/kitchen-dining' },
    ]);
    const via = (p: string) => legacyRedirect(p, normalizeQuery([]), clash);
    expect(via('/brands')).toBeNull();
    expect(via('/products/kitchen-dining')).toBeNull(); // a real product page whose slug is an old keyword
    expect(via('/api/v1/catalog/kitchen-dining')).toBeNull();
    expect(via('/_next/static/chunks/kitchen-dining')).toBeNull();
    expect(via('/banners/kitchen-dining.webp')).toBeNull();
    expect(via('/kitchen-dining')).toBe('/catalog/kitchen-dining');
  });

  it('the reserved segments cover every top-level page and file of the app', () => {
    const app = join(import.meta.dirname, '..', 'app');
    const tops = readdirSync(app, { withFileTypes: true }).flatMap((d) => {
      if (d.isDirectory()) return /^[[(_@]/.test(d.name) ? [] : [d.name];
      if (d.name === 'robots.ts') return ['robots.txt'];
      if (d.name === 'sitemap.ts') return ['sitemap.xml'];
      if (d.name === 'favicon.ico') return ['favicon.ico'];
      return [];
    });
    expect(tops.filter((t) => !RESERVED_SEGMENTS.has(t))).toEqual([]);
  });
});

describe('the data files can never cause an open redirect or a loop', () => {
  it.each([
    'https://evil.example/x',
    '//evil.example',
    '/\\evil.example',
    '/products/../../admin',
    '/products/x?next=//evil',
    'javascript:alert(1)',
    '/Products/UPPER',
    '/b/c', // a path no page serves would come back to the proxy
    '/api/v1/auth/logout',
    '/admin',
    '',
  ])('refuses the destination %s', (to) => {
    expect(isSafeTarget(to)).toBe(false);
    const m = buildLegacyMap([{ kind: 'product', id: '1', keyword: 'k', to }]);
    expect(m.dropped).toBe(1);
    expect(legacyRedirect('/index.php', normalizeQuery([['route', 'product/product'], ['product_id', '1']]), m)).toBeNull();
  });

  it('drops malformed entries and keeps the rest', () => {
    const m = buildLegacyMap([
      null,
      { kind: 'admin', id: '1', keyword: null, to: '/catalog' },
      { kind: 'product', id: '1 OR 1=1', keyword: null, to: '/catalog' },
      { kind: 'product', id: '7', keyword: null, to: '/products/ok' },
    ]);
    expect(m.dropped).toBe(3);
    expect(m.product.get('7')).toBe('/products/ok');
    expect(buildLegacyMap('not a list').dropped).toBe(0);
  });

  it('the committed data files are valid (nothing dropped)', () => {
    expect(buildLegacyMap(converted, extra).dropped).toBe(0);
  });
});
