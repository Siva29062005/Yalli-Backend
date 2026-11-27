import { describe, expect, it } from 'vitest';
import { ADMIN_SCREENS, canOpen, firstAllowedPath, screenFor } from './admin-access';

describe('admin screen access', () => {
  it('lets each role open only its screens', () => {
    const productManager = ['products.read', 'products.create', 'products.update', 'pricing.update'];
    const open = ADMIN_SCREENS.filter((s) => canOpen(productManager, s)).map((s) => s.name);
    expect(open).toEqual(['Products', 'Categories', 'Brands', 'Import']);
    expect(ADMIN_SCREENS.filter((s) => canOpen([], s))).toEqual([]);
  });

  it('lets moderators (and only them) open Reviews', () => {
    const reviews = ADMIN_SCREENS.find((s) => s.href === '/admin/reviews')!;
    expect(canOpen(['reviews.moderate'], reviews)).toBe(true);
    expect(canOpen(['products.read', 'orders.read'], reviews)).toBe(false);
  });

  it('opens refunds & returns with either payments.read or orders.read', () => {
    const refunds = ADMIN_SCREENS.find((s) => s.href === '/admin/refunds')!;
    expect(canOpen(['payments.read'], refunds)).toBe(true);
    expect(canOpen(['orders.read'], refunds)).toBe(true);
    expect(canOpen(['refunds.create'], refunds)).toBe(true); // customer support can request refunds
    expect(canOpen(['inventory.read'], refunds)).toBe(false);
  });

  it('gates the Phase 11 screens by the permission their endpoints need', () => {
    const screen = (href: string) => ADMIN_SCREENS.find((s) => s.href === href)!;
    expect(canOpen(['payments.read'], screen('/admin/finance'))).toBe(true);
    expect(canOpen(['orders.read', 'refunds.create'], screen('/admin/finance'))).toBe(false);
    expect(canOpen(['customers.read'], screen('/admin/customers'))).toBe(true);
    expect(canOpen(['users.manage'], screen('/admin/customers'))).toBe(false);
    expect(canOpen(['audit.read'], screen('/admin/audit'))).toBe(true);
    expect(canOpen(['users.manage', 'payments.read'], screen('/admin/audit'))).toBe(false);
    // import needs BOTH (its endpoint requires products.create AND pricing.update)
    expect(canOpen(['products.create', 'pricing.update'], screen('/admin/import'))).toBe(true);
    expect(canOpen(['products.create'], screen('/admin/import'))).toBe(false);
    expect(canOpen(['pricing.update'], screen('/admin/import'))).toBe(false);
    expect(canOpen(['products.read', 'products.update'], screen('/admin/import'))).toBe(false);
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
    expect(firstAllowedPath(['audit.read'])).toBe('/admin/audit');
    expect(firstAllowedPath(['customers.suspend'])).toBeNull();
    expect(firstAllowedPath([])).toBeNull();
  });
});
