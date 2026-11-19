import type { Metadata } from 'next';
import { AuthSplitShell } from '@/components/AuthShell';
import { RegisterForm } from './RegisterForm';

export const metadata: Metadata = { title: 'Create your account · Yalli', robots: { index: false } };

export default function RegisterPage() {
  return (
    <AuthSplitShell>
      <RegisterForm />
    </AuthSplitShell>
  );
}
