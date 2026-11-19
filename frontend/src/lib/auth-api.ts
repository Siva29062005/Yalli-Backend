import { ApiError, requestApi } from './http';

export interface RegisterInput {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  password: string;
  newsletter: boolean;
  acceptPrivacyPolicy: true;
}

const post = (endpoint: string, body: unknown) =>
  requestApi<null>(endpoint, { method: 'POST', body: JSON.stringify(body) });

export const registerAccount = (input: RegisterInput) => post('/auth/register', input);
export const verifyEmail = (token: string) => post('/auth/verify-email', { token });
export const resendVerification = (email: string) => post('/auth/resend-verification', { email });
export const forgotPassword = (email: string) => post('/auth/forgot-password', { email });
export const resetPassword = (token: string, newPassword: string) =>
  post('/auth/reset-password', { token, newPassword });

/** Mirrors the backend password policy so most problems are caught before submitting. */
export function passwordProblems(
  password: string,
  ctx: { email?: string; firstName?: string; lastName?: string } = {},
): string[] {
  const out: string[] = [];
  if (password.length < 12) out.push('Use at least 12 characters');
  if (password.length > 128) out.push('Use at most 128 characters');
  if (password && new Set(password).size < 5) out.push('Avoid repeating the same characters');
  const lower = password.toLowerCase();
  const words = (ctx.email?.split('@')[0]?.toLowerCase().split(/[^a-z0-9]+/) ?? []).filter(
    (w) => w.length >= 4 && !/^\d+$/.test(w),
  );
  if (words.some((w) => lower.includes(w))) out.push("Don't include your email name");
  if ([ctx.firstName, ctx.lastName].some((n) => n && n.trim().length >= 4 && lower.includes(n.trim().toLowerCase())))
    out.push("Don't include your name");
  if (/^(?:password|qwerty|123456|letmein|welcome|iloveyou|admin)/i.test(password))
    out.push('Avoid common passwords');
  return out;
}

/** Field-level messages from a backend validation error (`error.details[].path`). */
export function fieldErrors(error: unknown): Record<string, string> {
  if (!(error instanceof ApiError) || !Array.isArray(error.details)) return {};
  const out: Record<string, string> = {};
  for (const issue of error.details as { path?: string; message?: string }[]) {
    if (issue.path && issue.message && !out[issue.path]) {
      const msg = issue.message;
      out[issue.path] = issue.path === 'password' ? `Password ${msg}` : msg;
    }
  }
  return out;
}

export function errorMessage(error: unknown, fallback = 'Something went wrong. Please try again.') {
  if (error instanceof ApiError) {
    if (error.status === 429) return 'Too many attempts. Please wait a few minutes and try again.';
    if (error.status >= 500) return fallback;
    return error.message || fallback;
  }
  return fallback;
}
