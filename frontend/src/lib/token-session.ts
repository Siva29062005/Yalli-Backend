import { ApiError, requestApi, requestEnvelope, type ApiEnvelope } from './http';

/**
 * Browser session built on the backend's cookie mode.
 * - Access token: memory only.
 * - Refresh token: HttpOnly cookie the page can never read.
 * - CSRF token: not a credential on its own. Kept in Web Storage so a reload can swap the cookie
 *   for a new access token (sessionStorage = this tab only, localStorage = "remember me").
 */
export interface LoginResult {
  mfaRequired: boolean;
  mfaToken?: string;
  accessToken?: string;
}
interface TokenResult {
  accessToken: string;
  csrfToken?: string;
}

export interface TokenSessionOptions {
  csrfKey: string;
  deviceLabel: string;
  expiredEvent: string;
}

export function createTokenSession({ csrfKey, deviceLabel, expiredEvent }: TokenSessionOptions) {
  let accessToken: string | null = null;
  let restoring: Promise<boolean> | null = null;

  const readCsrf = () =>
    typeof window === 'undefined'
      ? null
      : sessionStorage.getItem(csrfKey) ?? localStorage.getItem(csrfKey);

  function rememberCsrf(token?: string, persistent?: boolean) {
    if (typeof window === 'undefined') return;
    if (!token) {
      sessionStorage.removeItem(csrfKey);
      localStorage.removeItem(csrfKey);
      return;
    }
    // Keep using whichever storage the session started in unless told otherwise.
    const useLocal = persistent ?? localStorage.getItem(csrfKey) !== null;
    (useLocal ? localStorage : sessionStorage).setItem(csrfKey, token);
    (useLocal ? sessionStorage : localStorage).removeItem(csrfKey);
  }

  function clear() {
    accessToken = null;
    rememberCsrf();
  }

  /** De-duplicated: refresh tokens rotate, and replaying one revokes the whole session. */
  function restore(): Promise<boolean> {
    if (accessToken) return Promise.resolve(true);
    const csrf = readCsrf();
    if (!csrf) return Promise.resolve(false);
    const call = () =>
      requestApi<TokenResult>('/auth/refresh', {
        method: 'POST',
        headers: { 'X-Auth-Mode': 'cookie', 'X-CSRF-Token': readCsrf() ?? csrf },
        body: JSON.stringify({}),
      });
    // Tabs of one browser share the refresh cookie: take turns (Web Locks), so a second tab refreshes with the token
    // the first one just received instead of replaying the old one. The server also tolerates a near-simultaneous
    // replay for a few seconds, for browsers without Web Locks.
    if (restoring) return restoring;
    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
    // request() resolves with the callback's resolved value (the DOM typing does not unwrap the promise).
    const run = locks ? (locks.request(`${csrfKey}:refresh`, call) as Promise<unknown> as Promise<TokenResult>) : call();
    restoring = run
      .then((result) => {
        accessToken = result.accessToken;
        rememberCsrf(result.csrfToken);
        return true;
      })
      .catch(() => {
        clear();
        return false;
      })
      .finally(() => {
        restoring = null;
      });
    return restoring;
  }

  const withAuth = (options: RequestInit): RequestInit => ({
    ...options,
    headers: {
      ...Object.fromEntries(new Headers(options.headers).entries()),
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
  });

  /** Runs one authenticated call, with a single silent refresh when the short-lived access token has expired. */
  async function authed<R>(run: (options: RequestInit) => Promise<R>, options: RequestInit): Promise<R> {
    try {
      return await run(withAuth(options));
    } catch (error) {
      // Only a dead ACCESS TOKEN is worth a refresh. Any other 401 (a wrong password or authenticator code) is about
      // this request: retrying it would submit the same guess twice (twice towards the MFA lockout).
      if (!(error instanceof ApiError) || error.status !== 401 || error.code !== 'ACCESS_TOKEN_INVALID') throw error;
      // Access tokens are short-lived: try one silent refresh before ending the session.
      accessToken = null;
      if (await restore()) {
        // The refresh succeeded, so the session is valid: a second 401 is about this request (e.g. a wrong password
        // on a re-auth form), not an expired session. Report it without signing the user out.
        return await run(withAuth(options));
      }
      clear();
      if (typeof window !== 'undefined') window.dispatchEvent(new Event(expiredEvent));
      throw error;
    }
  }

  const request = <T>(endpoint: string, options: RequestInit = {}): Promise<T> =>
    authed((o) => requestApi<T>(endpoint, o), options);

  /** Same as `request`, but also returns the envelope `meta` (pagination). */
  const requestPage = <T>(endpoint: string, options: RequestInit = {}): Promise<ApiEnvelope<T>> =>
    authed((o) => requestEnvelope<T>(endpoint, o), options);

  async function login(email: string, password: string, persistent = false): Promise<LoginResult> {
    clear();
    const result = await requestApi<LoginResult & { csrfToken?: string }>('/auth/login', {
      method: 'POST',
      headers: { 'X-Auth-Mode': 'cookie' },
      // `remember` decides whether the server gives the refresh cookie an expiry (it never does for staff).
      body: JSON.stringify({ email, password, deviceLabel, remember: persistent }),
    });
    accessToken = result.accessToken ?? null;
    rememberCsrf(result.csrfToken, persistent);
    return result;
  }

  async function verifyMfa(
    mfaToken: string,
    factor: { code: string } | { recoveryCode: string },
    persistent = false,
  ) {
    const result = await requestApi<TokenResult>('/auth/mfa/verify', {
      method: 'POST',
      headers: { 'X-Auth-Mode': 'cookie' },
      body: JSON.stringify({ mfaToken, ...factor, remember: persistent }),
    });
    accessToken = result.accessToken;
    rememberCsrf(result.csrfToken, persistent);
  }

  async function stepUp(code: string) {
    const result = await request<{ accessToken: string }>('/auth/mfa/step-up', {
      method: 'POST',
      body: JSON.stringify({ code }),
    });
    accessToken = result.accessToken;
  }

  async function logout() {
    try {
      if (accessToken || (await restore())) await request('/auth/logout', { method: 'POST' });
    } finally {
      clear();
    }
  }

  return { restore, request, requestPage, login, verifyMfa, stepUp, logout, clear };
}
