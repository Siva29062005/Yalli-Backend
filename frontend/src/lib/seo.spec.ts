import { describe, expect, it } from 'vitest';
import type { ProductDetail } from './catalog-api';
import { absoluteUrl, jsonLdScript, normalizeSiteUrl, paiseToDecimal, productJsonLd, sitemapEntries, websiteJsonLd } from './seo';

const variant = (amountMinor: number, inStock = true, sku = 'SKU-1') => ({
  id: sku, sku, name: null, optionValues: null, inStock, lowStock: false,
  price: { amountMinor, compareAtMinor: null, onSale: false, currency: 'INR' },
});
const product = (over: Partial<ProductDetail> = {}): ProductDetail => ({
  id: 'p1', slug: 'steamer', name: 'Momo Steamer', summary: 'Two tiers', descriptionHtml: '<p>x</p>',
  brand: { name: 'Yalli', slug: 'yalli' }, categories: [], tags: [], attributes: [],
  images: [{ url: 'https://cdn.example/a.jpg', altText: null, variantId: null }, { url: '/relative.jpg', altText: null, variantId: null }, { url: null, altText: null, variantId: null }],
  gstRateBps: 1800, variants: [variant(69000)], ...over,
});

describe('site url', () => {
  it('keeps only a clean http(s) base', () => {
    expect(normalizeSiteUrl('https://yalli.in/')).toBe('https://yalli.in');
    expect(normalizeSiteUrl(' https://yalli.in/shop/ ')).toBe('https://yalli.in/shop');
    expect(normalizeSiteUrl('javascript:alert(1)')).toBeUndefined();
    expect(normalizeSiteUrl('yalli.in')).toBeUndefined();
    expect(normalizeSiteUrl('')).toBeUndefined();
    expect(normalizeSiteUrl(undefined)).toBeUndefined();
  });
  it('builds absolute urls without double slashes', () => {
    expect(absoluteUrl('https://yalli.in', '/')).toBe('https://yalli.in');
    expect(absoluteUrl('https://yalli.in', '/help')).toBe('https://yalli.in/help');
  });
});

describe('paiseToDecimal', () => {
  it('uses integer maths', () => {
    expect(paiseToDecimal(69000)).toBe('690.00');
    expect(paiseToDecimal(5)).toBe('0.05');
    expect(paiseToDecimal(100_05)).toBe('100.05');
    expect(paiseToDecimal(0)).toBe('0.00');
    expect(() => paiseToDecimal(1.5)).toThrow(RangeError);
    expect(() => paiseToDecimal(-1)).toThrow(RangeError);
  });
});

describe('product structured data', () => {
  it('describes one price, stock, brand and only absolute images', () => {
    const ld = productJsonLd({ product: product(), url: 'https://yalli.in/products/steamer' });
    expect(ld).toMatchObject({
      '@type': 'Product', name: 'Momo Steamer', sku: 'SKU-1', brand: { name: 'Yalli' },
      image: ['https://cdn.example/a.jpg'],
      offers: { '@type': 'Offer', price: '690.00', priceCurrency: 'INR', availability: 'https://schema.org/InStock', url: 'https://yalli.in/products/steamer' },
    });
    expect(ld).not.toHaveProperty('aggregateRating');
  });
  it('uses an aggregate offer for several prices and says out of stock when nothing is available', () => {
    const ld = productJsonLd({ product: product({ variants: [variant(50000, false, 'A'), variant(90000, false, 'B')] }), url: undefined });
    expect(ld.offers).toEqual({ '@type': 'AggregateOffer', lowPrice: '500.00', highPrice: '900.00', priceCurrency: 'INR', offerCount: 2, availability: 'https://schema.org/OutOfStock' });
    expect(ld).not.toHaveProperty('sku');
  });
  it('adds a rating only when there are approved reviews', () => {
    expect(productJsonLd({ product: product(), rating: { count: 0, average: null }, url: undefined })).not.toHaveProperty('aggregateRating');
    expect(productJsonLd({ product: product(), rating: { count: 3, average: 4.3 }, url: undefined }).aggregateRating).toEqual({ '@type': 'AggregateRating', ratingValue: 4.3, reviewCount: 3 });
  });
  it('omits offers for a product with no variants and never leaks markup into the script tag', () => {
    expect(productJsonLd({ product: product({ variants: [] }), url: undefined })).not.toHaveProperty('offers');
    const text = jsonLdScript(productJsonLd({ product: product({ name: '</script><script>alert(1)</script>' }), url: undefined }));
    expect(text).not.toContain('</script>');
    expect(text).toContain('\\u003c/script>');
    expect(JSON.parse(text).name).toBe('</script><script>alert(1)</script>');
  });
});

describe('website structured data and sitemap', () => {
  it('points the search action at the catalogue search', () => {
    expect(websiteJsonLd({ name: 'Yalli', siteUrl: 'https://yalli.in' })).toMatchObject({
      '@type': 'WebSite', url: 'https://yalli.in', potentialAction: { target: 'https://yalli.in/catalog?q={search_term_string}' },
    });
  });
  it('lists public pages, categories and products once, never private areas', () => {
    const urls = sitemapEntries({ siteUrl: 'https://yalli.in', categorySlugs: ['kitchen', 'kitchen'], productSlugs: ['steamer', 'kettle'] }).map((e) => e.url);
    expect(urls).toContain('https://yalli.in');
    expect(urls).toContain('https://yalli.in/privacy');
    expect(urls).toContain('https://yalli.in/catalog/kitchen');
    expect(urls).toContain('https://yalli.in/products/steamer');
    expect(urls.filter((u) => u.endsWith('/catalog/kitchen'))).toHaveLength(1);
    expect(urls.some((u) => /\/(admin|account|cart|checkout|auth|orders|compare)/.test(u))).toBe(false);
  });
  it('stops at the 50,000-URL protocol limit', () => {
    const slugs = Array.from({ length: 60_000 }, (_, i) => `p-${i}`);
    expect(sitemapEntries({ siteUrl: 'https://yalli.in', categorySlugs: [], productSlugs: slugs })).toHaveLength(50_000);
  });
});
