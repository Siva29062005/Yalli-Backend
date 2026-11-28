import { describe, expect, it } from 'vitest';
import committed from '../data/legacy-redirects.json';
import { buildLegacyMap, isSafeTarget, resolveLegacy } from './legacy-redirects';

// the converter's output format (migration/redirects.json)
const entries = [
  { kind: 'product', id: '42', keyword: '3in1MomosMakerMachine', to: '/products/3in1momosmakermachine' },
  { kind: 'product', id: '45', keyword: null, to: '/products/night-lamp' },
  { kind: 'category', id: '20', keyword: 'kitchen-dining', to: '/catalog/kitchen-dining' },
  { kind: 'category', id: '20_27', keyword: 'cookware', to: '/catalog/cookware' },
  { kind: 'category', id: '33', keyword: 'desktops/mac', to: '/catalog/mac' },
  { kind: 'brand', id: '5', keyword: 'yalli-brand', to: '/brands/yalli' },
  { kind: 'information', id: '4', keyword: 'about-yalli', to: '/help' },
];
const map = buildLegacyMap(entries);
const q = (s = '') => new URLSearchParams(s);
const go = (path: string, query = '') => resolveLegacy(path.split('/').filter(Boolean), q(query), map);

describe('old OpenCart addresses', () => {
  it.each([
    ['product/product&product_id=42', '/products/3in1momosmakermachine'],
    ['product/product&path=20_27&product_id=45', '/products/night-lamp'],
    ['product/category&path=20', '/catalog/kitchen-dining'],
    ['product/category&path=20_27', '/catalog/cookware'],
    ['product/category&path=99_27', '/catalog/cookware'], // by the category's own id
    ['product/category', '/catalog'],
    ['product/manufacturer.info&manufacturer_id=5', '/brands/yalli'],
    ['product/manufacturer|info&manufacturer_id=5', '/brands/yalli'], // OpenCart 4.0.0/4.0.1
    ['product/manufacturer', '/brands'],
    ['information/information&information_id=4', '/help'], // the file overrides the default
    ['information/information&information_id=6', '/shipping'], // default
    ['product/special', '/specials'],
    ['product/search&search=steel bottle', '/catalog?q=steel%20bottle'],
    ['product/search&tag=lamp', '/catalog?q=lamp'],
    ['common/home', '/'],
    ['account/login', '/auth/login'],
    ['checkout/cart', '/cart'],
    ['PRODUCT/PRODUCT&product_id=42', '/products/3in1momosmakermachine'],
  ])('index.php?route=%s -> %s', (query, to) => {
    expect(go('/index.php', `route=${query}`)).toBe(to);
  });

  it('sends a bare /index.php home', () => {
    expect(go('/index.php')).toBe('/');
  });

  it.each([
    ['/3in1MomosMakerMachine', '/products/3in1momosmakermachine'],
    ['/kitchen-dining/3in1momosmakermachine', '/products/3in1momosmakermachine'],
    ['/kitchen-dining', '/catalog/kitchen-dining'],
    ['/kitchen-dining/cookware', '/catalog/cookware'],
    ['/en-gb/product/3in1momosmakermachine', '/products/3in1momosmakermachine'],
    ['/en-gb/catalog/desktops/mac', '/catalog/mac'],
    ['/3in1momosmakermachine.html', '/products/3in1momosmakermachine'],
    ['/yalli-brand', '/brands/yalli'],
    ['/delivery', '/shipping'],
  ])('SEO address %s -> %s', (path, to) => {
    expect(go(path)).toBe(to);
  });

  it('OpenCart 4 language path with ?route=', () => {
    expect(go('/en-gb', 'route=product/product&product_id=42')).toBe('/products/3in1momosmakermachine');
  });

  it.each([
    ['/index.php', 'route=product/product&product_id=999'],
    ['/index.php', 'route=product/product&product_id=42abc'],
    ['/index.php', 'route=product/product'],
    ['/index.php', 'route=extension/payment/whatever'],
    ['/no-such-page', ''],
    ['/a/b/c/d/e/f/g/h/i', ''],
    ['/', ''],
  ])('unknown %s?%s is a 404', (path, query) => {
    expect(go(path, query)).toBeNull();
  });

  it('never redirects a path to itself', () => {
    const loop = buildLegacyMap([{ kind: 'product', id: '1', keyword: 'x', to: '/x' }]);
    expect(resolveLegacy(['x'], q(), loop)).toBeNull();
  });
});

describe('the data file can never cause an open redirect', () => {
  it.each([
    'https://evil.example/x',
    '//evil.example',
    '/\\evil.example',
    '/products/../../admin',
    '/products/x?next=//evil',
    'javascript:alert(1)',
    '/Products/UPPER',
    '',
  ])('refuses the destination %s', (to) => {
    expect(isSafeTarget(to)).toBe(false);
    const m = buildLegacyMap([{ kind: 'product', id: '1', keyword: 'k', to }]);
    expect(m.dropped).toBe(1);
    expect(resolveLegacy(['index.php'], q('route=product/product&product_id=1'), m)).toBeNull();
  });

  it('drops malformed entries and keeps the rest', () => {
    const m = buildLegacyMap([
      null,
      { kind: 'admin', id: '1', keyword: null, to: '/x' },
      { kind: 'product', id: '1 OR 1=1', keyword: null, to: '/x' },
      { kind: 'product', id: '7', keyword: null, to: '/products/ok' },
    ]);
    expect(m.dropped).toBe(3);
    expect(m.product.get('7')).toBe('/products/ok');
    expect(buildLegacyMap('not a list').dropped).toBe(0);
  });

  it('the committed data file is valid (nothing dropped)', () => {
    expect(buildLegacyMap(committed).dropped).toBe(0);
  });
});
