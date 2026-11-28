/**
 * Cookie names. The __Secure- prefix is only valid (and only requested) when cookies are Secure. The staff console
 * (`X-Auth-Mode: cookie-admin`) has its OWN pair, so signing in to the console never replaces the storefront's
 * session in the same browser, and the other way round.
 */
export type CookieScope = 'shop' | 'admin';
export const cookieNames = (secure: boolean, scope: CookieScope = 'shop') => {
  const suffix = scope === 'admin' ? '_admin' : '';
  return {
    refresh: `${secure ? '__Secure-' : ''}yalli_rt${suffix}`,
    csrf: `${secure ? '__Secure-' : ''}yalli_csrf${suffix}`,
  };
};
/** Refresh cookie is scoped to the auth endpoints only, so it is never sent with ordinary API calls. */
export const REFRESH_COOKIE_PATH = '/api/v1/auth';
export const AUTH_MODE_HEADER = 'x-auth-mode';
export const CSRF_HEADER = 'x-csrf-token';
