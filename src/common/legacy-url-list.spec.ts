import { describe, expect, it } from 'vitest';
import { isHomeAddress, parseOldUrls } from './legacy-url-list.js';

describe('old address list', () => {
  it('keeps path and query of each address, once, and skips comments', () => {
    expect(
      parseOldUrls(
        [
          '# exported 2026-12-01',
          'https://www.yalli.in/index.php?route=product/product&product_id=42',
          'http://yalli.in/kitchen-dining',
          '/delivery',
          '',
          'https://yalli.in/kitchen-dining',
        ].join('\n'),
      ),
    ).toEqual({
      paths: [
        '/index.php?route=product/product&product_id=42',
        '/kitchen-dining',
        '/delivery',
      ],
      rejected: [],
      capped: false,
    });
  });

  it('reads a pasted sitemap (with &amp;) and a Search Console CSV export', () => {
    const xml =
      '<?xml version="1.0"?><urlset><url><loc>https://yalli.in/index.php?route=product/product&amp;product_id=42</loc></url>' +
      '<url><loc> https://yalli.in/kitchen-dining </loc></url></urlset>';
    expect(parseOldUrls(xml).paths).toEqual([
      '/index.php?route=product/product&product_id=42',
      '/kitchen-dining',
    ]);
    const csv =
      'Top pages,Clicks,Impressions,CTR,Position\nhttps://yalli.in/foo,12,345,3.5%,7.1\n"https://yalli.in/index.php?route=product/category&path=20",3,40,7.5%,4.2\n';
    expect(parseOldUrls(csv)).toEqual({
      paths: ['/foo', '/index.php?route=product/category&path=20'],
      rejected: [],
      capped: false,
    });
  });

  it('rejects what is not an http(s) address or a path', () => {
    const r = parseOldUrls(
      'ftp://x/y\njavascript:alert(1)\nnot a url\n//evil.example/x',
    );
    expect(r.paths).toEqual([]);
    expect(r.rejected).toHaveLength(4);
  });

  it('says when the cap cut the list', () => {
    const many = Array.from({ length: 20 }, (_, i) => `/p${i}`).join('\n');
    const r = parseOldUrls(many, 5);
    expect(r.paths).toHaveLength(5);
    expect(r.capped).toBe(true);
  });

  it('knows which old addresses are the home page', () => {
    for (const p of [
      '/',
      '/index.php',
      '/index.php?route=common/home',
      '/?route=common/home',
    ])
      expect(isHomeAddress(p)).toBe(true);
    for (const p of [
      '/index.php?route=product/product&product_id=42',
      '/index.php?_route_=lamp',
      '/kitchen-dining',
    ])
      expect(isHomeAddress(p)).toBe(false);
  });
});
