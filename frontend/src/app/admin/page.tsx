'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { AdminPage, Alert } from '@/components/AdminKit';
import { useAdminSession } from '@/components/AdminContext';
import { firstAllowedPath } from '@/lib/admin-access';

/** `/admin`: send staff to the first screen their role can use. */
export default function AdminHome() {
  const { identity } = useAdminSession();
  const router = useRouter();
  const target = firstAllowedPath(identity.permissions);
  useEffect(() => {
    if (target) router.replace(target);
  }, [target, router]);
  if (target) return <p role="status" className="p-8 text-sm text-[#4A5550]">Opening your workspace…</p>;
  return (
    <AdminPage title="Staff workspace">
      <Alert kind="warning">Your account has staff access but none of the screens in this workspace are available to its role. Ask an administrator to review your role.</Alert>
    </AdminPage>
  );
}
