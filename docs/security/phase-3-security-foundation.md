# Phase 3 — Security foundation (implemented)

Status: implemented and verified by automated tests (see "Evidence"). Docker end-to-end verification:
`./scripts/verify-docker.sh` (run by the developer; includes an auth smoke test through the real container).
This document describes what the code actually does. Anything not listed here is not implemented.

## Scope delivered

Registration, email + phone verification, login, rotating refresh tokens with theft detection, device sessions,
password reset / change, TOTP MFA with recovery codes and step-up, RBAC with rank rules, ownership-scoped data access,
rate limiting, an append-only audit trail, and the boot-time "no route without a policy" guarantee.

## Endpoints (`/api/v1`)

| Endpoint | Access | Notes |
|---|---|---|
| `POST /auth/register` | public | 202 always (no enumeration); captcha; password policy + breach check |
| `POST /auth/verify-email`, `/auth/resend-verification` | public | single-use 24 h token; resend is silent |
| `POST /auth/login` | public | per-IP + per-account limits; lockout; MFA challenge when enabled |
| `POST /auth/mfa/verify` | public (challenge token) | single-use, 5 attempts |
| `POST /auth/refresh` | public (refresh token) | rotation + reuse detection; CSRF guard in cookie mode |
| `POST /auth/forgot-password`, `/auth/reset-password` | public | 202 always; 30 min single-use token; revokes all sessions |
| `POST /auth/logout`, `/auth/logout-all`, `GET/DELETE /auth/sessions[/:id]` | authenticated | ownership enforced in the query |
| `POST /auth/change-password` | authenticated | current password required; other devices signed out |
| `POST /auth/phone/send-otp`, `/auth/phone/verify` | authenticated | 6-digit OTP, 5 min, 5 attempts |
| `POST /auth/mfa/enroll`, `/confirm`, `/step-up`, `/disable`, `/recovery-codes/regenerate` | authenticated | password and/or TOTP required |
| `GET /me` | authenticated | explicit field allow-list |
| `GET /admin/roles`, `/admin/permissions` | `users.manage` / `permissions.manage` + MFA step-up | |
| `POST/DELETE /admin/users/:id/roles[/:role]`, `PATCH /admin/users/:id/status` | `users.manage` / `customers.suspend` + step-up (10 min) | rank rules, audited |
| `GET /.well-known/jwks.json`, `/health/*` | public | verification keys only |

## Control map

| Requirement | Implementation | Verified by |
|---|---|---|
| Password hashing | Argon2id m=64 MiB t=3 p=1, parameters stored in the hash, rehash on login, bounded concurrency | `registration-login` (hash format), `PasswordService` |
| Password policy | 12–128 chars, no email/name words, no trivial repetition, HIBP k-anonymity breach check | policy unit tests, registration tests |
| Access tokens | EdDSA, 15 min, claims `sub,sid,amr,auth_time,jti,iss,aud,iat,exp` only, `typ=at+jwt`, `kid` rotation | `tokens-sessions` (claims, tampering matrix) |
| Immediate revocation | per-request session check (Redis flag → cache → DB); authz snapshot invalidated on change | logout / suspension / role-revoke tests |
| Refresh tokens | 256-bit opaque, SHA-256 stored, rotate every use, reuse ⇒ whole session revoked + alert | reuse + concurrency tests |
| Cookie mode + CSRF | HttpOnly, Secure, SameSite=Strict, path-scoped refresh cookie; double-submit CSRF token + Origin allow-list | cookie/CSRF tests |
| Brute force / stuffing | per-IP and per-account limits; lockout 15 min doubling to 24 h; locked accounts are not password-tested; uniform 401 | login tests |
| Enumeration | uniform register/forgot/resend responses; dummy hash for unknown users; detached work | enumeration tests |
| MFA | TOTP (otplib), secret AES-256-GCM encrypted & bound to the user, single-use time-steps, recovery codes (hashed, single-use), step-up | `password-mfa` |
| Authorization | global deny-by-default guards, server-resolved permissions, rank rules (no self-change, no grant ≥ own rank, no laundering), step-up on admin | `authorization`, `role-policy.spec` |
| No route without a policy | `AccessPolicyAuditor` refuses to boot | `authorization` ("REFUSES TO START") |
| BOLA | repositories query by authenticated user id; foreign ids ⇒ 404 | session BOLA test |
| Mass assignment | strict Zod schemas reject unknown fields | registration + admin tests |
| Audit | append-only (trigger + revoked grants), sanitised metadata, no credentials | audit tests |
| Rate limiting | Redis fixed windows, global + per-route + per-user, `Retry-After`, sensitive limits fail closed | rate-limit tests |
| Secrets | env validation; production refuses dev drivers, missing captcha/HIBP, insecure cookies | `env.spec` |

## Evidence (this change)

- Unit: 51 tests (policy matrix, role rules, password policy, env guards, error filter, envelope, admin service).
- E2E against a real PostgreSQL with the production role split and migrations: 130 tests, stable over repeated runs.
- `npm run check` = prettier + oxlint (type-aware) + tsc + unit + e2e + build: green.

## Operations

- **First admin**: set `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD`, run `npm run seed` (Docker: `docker compose --profile tools run --rm seed`).
  The command is idempotent and only creates an admin when none exists. The admin must enrol MFA before any admin endpoint works.
- **Signing-key rotation**: deploy a new `JWT_KEY_ID` + `JWT_PRIVATE_KEY_B64`; move the old PUBLIC key into
  `JWT_RETIRED_PUBLIC_KEYS_JSON`; remove it after `JWT_ACCESS_TTL_SECONDS` has elapsed.
- **Reverse proxy**: `TRUST_PROXY_HOPS` must equal the number of trusted proxies in front of the app. Too high lets clients
  spoof `X-Forwarded-For` and bypass IP rate limits; too low rate-limits the proxy itself.
- **Alerts to create** (log/metric names): `Audit write failed`, `auth.refresh.reuse_detected`, `auth.account.locked`,
  `security.rate_limited` spikes, `access.denied` spikes, `access.role.*`.

## Known limitations and open risks

1. **Notifications are best-effort and synchronous**, not transactional-outbox (arrives in Phase 5). The `console` driver prints
   one-time links and is rejected in production, so a production boot is intentionally impossible until Phase 6 adds SES/MSG91.
2. **Two simultaneous refreshes from one client** (e.g. two tabs) look like token reuse and end the session. Clients must
   single-flight refreshes; a short server-side grace window can be added if this proves painful.
3. **Audit writes do not block requests** (an outage is logged, not fatal). Trade-off: availability over completeness.
4. **Redis outage**: sensitive rate limits fail closed (503); the per-request session check is not wrapped, so authenticated
   requests also fail until Redis returns. Safe, but should be mapped to 503 and monitored.
5. **Phone OTPs** are 6 digits hashed with the row id; if the database leaked inside the 5-minute window they could be brute-forced offline.
6. **Recovery codes** use SHA-256 (80-bit random codes), not a slow hash.
7. **MFA encryption key rotation** has no re-encryption tool yet (one active key id).
8. **Anomaly detection** is limited to new-device alerts and lockouts (no geo/impossible-travel).
9. **Captcha (Turnstile) and HIBP adapters are tested only through fakes**; they have not been exercised against the live services.
10. **Staff MFA** is enforced by step-up on admin endpoints, not by blocking login; staff without MFA simply cannot use admin APIs.
11. Not implemented yet: email change, account deletion / data export, WebAuthn, `login_attempts` table (the audit log is used instead).
12. Docker end-to-end results are only as good as the last `verify-docker.sh` run by the developer.
