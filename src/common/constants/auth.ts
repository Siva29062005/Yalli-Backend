/** Cookie names. The __Secure- prefix is only valid (and only requested) when cookies are Secure. */
export const cookieNames = (secure: boolean) => ({
  refresh: secure ? '__Secure-yalli_rt' : 'yalli_rt',
  csrf: secure ? '__Secure-yalli_csrf' : 'yalli_csrf',
});
/** Refresh cookie is scoped to the auth endpoints only, so it is never sent with ordinary API calls. */
export const REFRESH_COOKIE_PATH = '/api/v1/auth';
export const AUTH_MODE_HEADER = 'x-auth-mode';
export const CSRF_HEADER = 'x-csrf-token';
