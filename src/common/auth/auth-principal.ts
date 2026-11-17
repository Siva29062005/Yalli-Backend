/** The authenticated caller, rebuilt on EVERY request from server-side state (never from token claims). */
export interface AuthPrincipal {
  userId: string;
  sessionId: string;
  /** Authentication methods used for this access token, e.g. ['pwd'] or ['pwd','otp']. */
  amr: readonly string[];
  /** Epoch seconds of the most recent (re-)authentication. */
  authTime: number;
  roles: readonly { name: string; rank: number }[];
  permissions: ReadonlySet<string>;
  maxRank: number;
}
