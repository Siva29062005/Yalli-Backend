/**
 * Which staff screen needs which permission. This only decides what the UI SHOWS: every API route still enforces its
 * own permission on the server, so a wrong entry here can hide a screen but never grant access to anything.
 * `anyOf` must match the permissions of the endpoints the screen loads first (see the @RequirePermissions on them).
 */
export interface AdminScreen {
  name: string;
  href: string;
  /** The screen is available when the staff member holds at least one of these… */
  anyOf: readonly string[];
  /** …and all of these (for endpoints whose @RequirePermissions lists several, all required). */
  allOf?: readonly string[];
}

export const ADMIN_SCREENS: readonly AdminScreen[] = [
  { name: 'Overview', href: '/admin/analytics', anyOf: ['analytics.read'] },
  { name: 'Products', href: '/admin/products', anyOf: ['products.read'] },
  { name: 'Categories', href: '/admin/categories', anyOf: ['products.read'] },
  { name: 'Brands', href: '/admin/brands', anyOf: ['products.read'] },
  { name: 'Import', href: '/admin/import', anyOf: ['products.create'], allOf: ['products.create', 'pricing.update'] },
  { name: 'Inventory', href: '/admin/inventory', anyOf: ['inventory.read'] },
  { name: 'Orders', href: '/admin/orders', anyOf: ['orders.read'] },
  { name: 'Refunds & returns', href: '/admin/refunds', anyOf: ['payments.read', 'orders.read', 'refunds.create'] },
  { name: 'Finance', href: '/admin/finance', anyOf: ['payments.read'] },
  { name: 'Customers', href: '/admin/customers', anyOf: ['customers.read'] },
  { name: 'Messages', href: '/admin/messages', anyOf: ['customers.read'] },
  { name: 'Reviews', href: '/admin/reviews', anyOf: ['reviews.moderate'] },
  { name: 'Users & roles', href: '/admin/users', anyOf: ['users.manage'] },
  { name: 'Audit log', href: '/admin/audit', anyOf: ['audit.read'] },
  { name: 'Coupons', href: '/admin/coupons', anyOf: ['coupons.manage'] },
  { name: 'Shipping', href: '/admin/shipping', anyOf: ['shipments.manage'] },
];

/**
 * `permissions` is null when the server did not report them (an older backend): then nothing is hidden, because hiding is
 * cosmetic and the API refuses anything the role may not do.
 */
export function canOpen(permissions: readonly string[] | null, screen: Pick<AdminScreen, 'anyOf' | 'allOf'>): boolean {
  return (
    permissions === null ||
    (screen.anyOf.some((p) => permissions.includes(p)) && (screen.allOf ?? []).every((p) => permissions.includes(p)))
  );
}

/** The screen a path belongs to (`/admin/products/new` belongs to Products), or null for `/admin` and unknown paths. */
export function screenFor(pathname: string): AdminScreen | null {
  return ADMIN_SCREENS.find((s) => pathname === s.href || pathname.startsWith(`${s.href}/`)) ?? null;
}

/** Where to send staff after sign-in: the first screen their role can open. */
export function firstAllowedPath(permissions: readonly string[] | null): string | null {
  return ADMIN_SCREENS.find((s) => canOpen(permissions, s))?.href ?? null;
}
