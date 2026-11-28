import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AuthSplitShell } from '@/components/AuthShell';
import { OldStoreNotice } from '@/components/OldStoreNotice';
import { LoginForm } from './LoginForm';

export const metadata: Metadata = { title: 'Log in · Yalli', robots: { index: false } };

export default function LoginPage() {
  return (
    <AuthSplitShell>
      <OldStoreNotice />
      <Suspense>
        <LoginForm />
      </Suspense>
    </AuthSplitShell>
  );
}
