import { describe, expect, it } from 'vitest';
import { ADMIN_SCREENS, canOpen, firstAllowedPath, screenFor } from './admin-access';

describe('admin screen access', () => {
  it('lets each role open only its screens', () => {
    const productManager = ['products.read', 'products.create', 'products.update'];
    const open = ADMIN_SCREENS.filter((s) => canOpen(productManager, s)).map((s) => s.name);
    expect(open).toEqual(['Products', 'Categories']);
    expect(ADMIN_SCREENS.filter((s) => canOpen([], s))).toEqual([]);
  });

  it('opens refunds & returns with either payments.read or orders.read', () => {
    const refunds = ADMIN_SCREENS.find((s) => s.href === '/admin/refunds')!;
    expect(canOpen(['payments.read'], refunds)).toBe(true);
    expect(canOpen(['orders.read'], refunds)).toBe(true);
    expect(canOpen(['refunds.create'], refunds)).toBe(true); // customer support can request refunds
    expect(canOpen(['inventory.read'], refunds)).toBe(false);
  });

  it('maps nested paths to their screen and never matches by prefix of another name', () => {
    expect(screenFor('/admin/products/new')?.name).toBe('Products');
    expect(screenFor('/admin/products/0190-abc')?.name).toBe('Products');
    expect(screenFor('/admin/productsx')).toBeNull();
    expect(screenFor('/admin')).toBeNull();
    expect(screenFor('/admin/login')).toBeNull();
  });

  it('shows everything when the server does not report permissions (older backend), since the API still enforces them', () => {
    expect(ADMIN_SCREENS.every((s) => canOpen(null, s))).toBe(true);
    expect(firstAllowedPath(null)).toBe('/admin/analytics');
  });

  it('lands on the first screen the role can use, or nowhere', () => {
    expect(firstAllowedPath(['analytics.read', 'orders.read'])).toBe('/admin/analytics');
    expect(firstAllowedPath(['inventory.read'])).toBe('/admin/inventory');
    expect(firstAllowedPath(['reviews.moderate'])).toBeNull();
    expect(firstAllowedPath([])).toBeNull();
  });
});
