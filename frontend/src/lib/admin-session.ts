import { createTokenSession } from './token-session';

// Staff sessions are always tab-scoped: closing the tab ends them.
const session = createTokenSession({
  csrfKey: 'yalli_admin_csrf',
  deviceLabel: 'Yalli staff workspace',
  expiredEvent: 'admin-session-expired',
});

export interface AdminIdentity {
  id: string;
  email: string;
  roles: string[];
  mfaEnabled: boolean;
  /** Effective permissions of this account (from the server); null when an older backend does not report them. Cosmetic: the API enforces them. */
  permissions: string[] | null;
}

export const restoreAdminSession = session.restore;
export const adminRequest = session.request;
export const adminRequestPage = session.requestPage;
export const adminLogin = (email: string, password: string) => session.login(email, password, false);
export const adminVerify = (mfaToken: string, code: string) => session.verifyMfa(mfaToken, { code }, false);
export const adminStepUp = session.stepUp;
export const adminLogout = session.logout;
export const clearAdminSession = session.clear;
