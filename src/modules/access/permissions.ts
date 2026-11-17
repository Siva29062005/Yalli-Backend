/**
 * Single source of truth for the permission catalogue and the default role matrix.
 * Mirrors docs/architecture/PROPOSAL.md section 7; a unit test keeps the invariants honest.
 * The database is seeded from this file (idempotent) - nothing is granted implicitly.
 */
export const Permission = {
  ProductsRead: 'products.read',
  ProductsCreate: 'products.create',
  ProductsUpdate: 'products.update',
  ProductsDelete: 'products.delete',
  ProductsPublish: 'products.publish',
  PricingUpdate: 'pricing.update',
  CouponsManage: 'coupons.manage',
  InventoryRead: 'inventory.read',
  InventoryAdjust: 'inventory.adjust',
  OrdersRead: 'orders.read',
  OrdersUpdate: 'orders.update',
  ShipmentsManage: 'shipments.manage',
  PaymentsRead: 'payments.read',
  RefundsCreate: 'refunds.create',
  RefundsApprove: 'refunds.approve',
  CustomersRead: 'customers.read',
  CustomersUpdate: 'customers.update',
  CustomersSuspend: 'customers.suspend',
  ReviewsModerate: 'reviews.moderate',
  UsersManage: 'users.manage',
  RolesManage: 'roles.manage',
  PermissionsManage: 'permissions.manage',
  AuditRead: 'audit.read',
  AnalyticsRead: 'analytics.read',
} as const;
export type PermissionName = (typeof Permission)[keyof typeof Permission];
export const ALL_PERMISSIONS: readonly PermissionName[] =
  Object.values(Permission);

export const RoleName = {
  SuperAdmin: 'SUPER_ADMIN',
  Admin: 'ADMIN',
  ProductManager: 'PRODUCT_MANAGER',
  InventoryManager: 'INVENTORY_MANAGER',
  OrderManager: 'ORDER_MANAGER',
  FinanceManager: 'FINANCE_MANAGER',
  CustomerSupport: 'CUSTOMER_SUPPORT',
  Customer: 'CUSTOMER',
} as const;
export type RoleNameValue = (typeof RoleName)[keyof typeof RoleName];

export interface RoleDefinition {
  rank: number;
  description: string;
  permissions: readonly PermissionName[];
}

const P = Permission;

export const ROLE_DEFINITIONS: Readonly<Record<RoleNameValue, RoleDefinition>> =
  {
    SUPER_ADMIN: {
      rank: 100,
      description: 'Full control, including roles and permissions',
      permissions: ALL_PERMISSIONS,
    },
    ADMIN: {
      rank: 80,
      description:
        'Operates the store; cannot manage roles/permissions or approve refunds',
      permissions: [
        P.ProductsRead,
        P.ProductsCreate,
        P.ProductsUpdate,
        P.ProductsDelete,
        P.ProductsPublish,
        P.PricingUpdate,
        P.CouponsManage,
        P.InventoryRead,
        P.InventoryAdjust,
        P.OrdersRead,
        P.OrdersUpdate,
        P.ShipmentsManage,
        P.PaymentsRead,
        P.CustomersRead,
        P.CustomersUpdate,
        P.CustomersSuspend,
        P.ReviewsModerate,
        P.UsersManage,
        P.AuditRead,
        P.AnalyticsRead,
      ],
    },
    PRODUCT_MANAGER: {
      rank: 50,
      description: 'Catalogue and pricing',
      permissions: [
        P.ProductsRead,
        P.ProductsCreate,
        P.ProductsUpdate,
        P.ProductsPublish,
        P.PricingUpdate,
        P.InventoryRead,
        P.ReviewsModerate,
      ],
    },
    INVENTORY_MANAGER: {
      rank: 50,
      description: 'Stock levels and adjustments',
      permissions: [P.ProductsRead, P.InventoryRead, P.InventoryAdjust],
    },
    ORDER_MANAGER: {
      rank: 50,
      description: 'Order fulfilment and shipping',
      permissions: [
        P.ProductsRead,
        P.InventoryRead,
        P.OrdersRead,
        P.OrdersUpdate,
        P.ShipmentsManage,
      ],
    },
    FINANCE_MANAGER: {
      rank: 50,
      description: 'Payments, refunds, coupons, financial audit and analytics',
      permissions: [
        P.OrdersRead,
        P.PaymentsRead,
        P.RefundsCreate,
        P.RefundsApprove,
        P.PricingUpdate,
        P.CouponsManage,
        P.AuditRead,
        P.AnalyticsRead,
      ],
    },
    CUSTOMER_SUPPORT: {
      rank: 50,
      description:
        'Assists customers; can request refunds but not approve them',
      permissions: [
        P.ProductsRead,
        P.OrdersRead,
        P.RefundsCreate,
        P.CustomersRead,
        P.ReviewsModerate,
      ],
    },
    // Customers have NO admin permissions; self-service endpoints rely on authentication + ownership checks.
    CUSTOMER: { rank: 10, description: 'Storefront customer', permissions: [] },
  };

export const STAFF_ROLE_RANK_THRESHOLD = 50;
