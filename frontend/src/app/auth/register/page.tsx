import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AuthSplitShell } from '@/components/AuthShell';
import { OldStoreNotice } from '@/components/OldStoreNotice';
import { RegisterForm } from './RegisterForm';

export const metadata: Metadata = { title: 'Create your account · Yalli', robots: { index: false } };

export default function RegisterPage() {
  return (
    <AuthSplitShell>
      <OldStoreNotice />
      {/* useSearchParams (the `next` target) needs a Suspense boundary on a prerendered page. */}
      <Suspense>
        <RegisterForm />
      </Suspense>
    </AuthSplitShell>
  );
}
