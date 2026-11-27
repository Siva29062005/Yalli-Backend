import { describe, expect, it } from 'vitest';
import { safeNext } from './safe-redirect';

describe('safeNext (open-redirect defence)', () => {
  it.each([
    ['/cart', '/cart'],
    ['/account/orders/abc?tab=returns#x', '/account/orders/abc?tab=returns#x'],
    ['/products/steel%20bottle', '/products/steel%20bottle'],
    ['/catalog/../cart', '/cart'],
  ])('keeps a same-site path: %s', (input, expected) => {
    expect(safeNext(input)).toBe(expected);
  });

  it.each([
    '//evil.example',
    '/\\evil.example',
    '/\t/evil.example',
    '/\n/evil.example',
    '/\r/evil.example',
    '/%09/evil.example'.replace('%09', '\t'),
    '/.//evil.example',
    '/./\\evil.example',
    'https://evil.example',
    'javascript:alert(1)',
    'evil.example',
    '',
    '/auth/login',
    '/auth',
    '/admin',
    '/admin/orders',
    `/${'a'.repeat(3000)}`,
  ])('rejects %j', (input) => {
    expect(safeNext(input)).toBe('/account/profile');
  });

  it('uses the given fallback and handles null', () => {
    expect(safeNext(null, '/')).toBe('/');
    expect(safeNext('//x', '/cart')).toBe('/cart');
  });

  it('does not treat lookalike paths as staff or auth pages', () => {
    expect(safeNext('/administrative-info')).toBe('/administrative-info');
    expect(safeNext('/authors')).toBe('/authors');
  });
});
