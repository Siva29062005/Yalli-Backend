import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AuthSplitShell } from '@/components/AuthShell';
import { LoginForm } from './LoginForm';

export const metadata: Metadata = { title: 'Log in · Yalli', robots: { index: false } };

export default function LoginPage() {
  return (
    <AuthSplitShell>
      <Suspense>
        <LoginForm />
      </Suspense>
    </AuthSplitShell>
  );
}
