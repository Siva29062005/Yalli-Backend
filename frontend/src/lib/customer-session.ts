import { createTokenSession } from './token-session';

export const CUSTOMER_SESSION_EXPIRED = 'customer-session-expired';

/** Customer session. "Remember me" keeps the CSRF token in localStorage so the session survives closing the browser. */
export const customerSession = createTokenSession({
  csrfKey: 'yalli_customer_csrf',
  deviceLabel: 'Yalli storefront',
  expiredEvent: CUSTOMER_SESSION_EXPIRED,
});

/** Shape returned by `GET /me`. */
export interface CustomerProfile {
  id: string;
  email: string;
  phone: string | null;
  emailVerified: boolean;
  phoneVerified: boolean;
  mfaEnabled: boolean;
  firstName: string | null;
  lastName: string | null;
  newsletterSubscribed: boolean;
  roles: string[];
  createdAt: string;
}

export function displayName(p: Pick<CustomerProfile, 'firstName' | 'lastName' | 'email'>) {
  return [p.firstName, p.lastName].filter(Boolean).join(' ') || p.email.split('@')[0];
}

/** Only same-site paths are allowed as post-login redirects (prevents open redirects). */
export function safeNext(next: string | null | undefined, fallback = '/account/profile') {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return fallback;
  if (next.startsWith('/auth/') || next.startsWith('/admin')) return fallback;
  return next;
}
