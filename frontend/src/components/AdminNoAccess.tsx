'use client';

import { AdminPage, Alert } from '@/components/AdminKit';
import { useAdminSession } from '@/components/AdminContext';
import type { AdminScreen } from '@/lib/admin-access';

/** Shown instead of a screen the signed-in role cannot use. The API would refuse the calls anyway. */
export function AdminNoAccess({ screen }: { screen: AdminScreen }) {
  const { identity } = useAdminSession();
  const roles = identity.roles.filter((r) => r !== 'CUSTOMER').map((r) => r.toLowerCase().replaceAll('_', ' '));
  return (
    <AdminPage title={screen.name}>
      <Alert kind="warning">
        Your role{roles.length === 1 ? '' : 's'} ({roles.join(', ') || 'none'}) cannot open this area. Pick another screen from the menu, or ask an administrator if you need access.
      </Alert>
    </AdminPage>
  );
}
