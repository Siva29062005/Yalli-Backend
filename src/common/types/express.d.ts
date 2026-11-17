import type { AuthPrincipal } from '../auth/auth-principal.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by JwtAuthGuard on authenticated requests only. */
      auth?: AuthPrincipal;
    }
  }
}
export {};
