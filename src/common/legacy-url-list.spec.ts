import { describe, expect, it } from 'vitest';
import { parseOldUrls } from './legacy-url-list.js';

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
      rejected: 0,
    });
  });

  it('rejects what is not an http(s) address or a path', () => {
    expect(
      parseOldUrls(
        'ftp://x/y\njavascript:alert(1)\nnot a url\n//evil.example/x',
      ),
    ).toEqual({ paths: [], rejected: 4 });
  });

  it('stops at the cap', () => {
    const many = Array.from({ length: 20 }, (_, i) => `/p${i}`).join('\n');
    expect(parseOldUrls(many, 5).paths).toHaveLength(5);
  });
});
