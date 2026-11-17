# Authentication and authorization flows (as implemented)

## Login, refresh rotation and theft detection

```mermaid
sequenceDiagram
  autonumber
  participant C as Client
  participant A as API
  participant R as Redis
  participant P as PostgreSQL
  C->>A: POST /auth/login (email, password)
  A->>R: rate limits (ip, account)
  A->>P: load user (unknown/locked: dummy Argon2 + uniform 401)
  A->>A: verify Argon2id
  alt MFA enabled
    A->>R: store single-use challenge (5 min, 5 attempts)
    A-->>C: mfaRequired + mfaToken
    C->>A: POST /auth/mfa/verify (mfaToken, TOTP | recovery code)
  end
  A->>P: create session + refresh token (SHA-256 only)
  A-->>C: access JWT (15 min) + refresh token (body, or HttpOnly cookie)
  C->>A: POST /auth/refresh (refresh token)
  A->>P: claim token atomically (used_at), insert next token
  A-->>C: new access + refresh
  Note over C,A: Same old token presented again
  C->>A: POST /auth/refresh (already-used token)
  A->>P: revoke WHOLE session, audit, alert owner
  A->>R: revocation flag (kills access tokens now)
  A-->>C: 401
```

## Per-request authorization (deny by default)

```mermaid
flowchart TD
  Q[Request] --> RL[IP rate limit]
  RL --> J{Route @Public?}
  J -- yes --> H[Handler]
  J -- no --> V[Verify EdDSA JWT: alg, kid, iss, aud, typ, exp]
  V --> S{Session alive? Redis flag / cache / DB}
  S -- no --> U401[401]
  S -- yes --> L[Load roles + permissions from DB, cached 60 s]
  L --> AC{User ACTIVE?}
  AC -- no --> U401
  AC -- yes --> P{Route policy declared?}
  P -- none --> D403[403 + audit]
  P -- Authenticated --> ST
  P -- Permissions --> PM{Has ALL permissions?}
  PM -- no --> D403
  PM -- yes --> ST{Step-up required?}
  ST -- yes, stale/absent --> SU403[403 STEP_UP_REQUIRED]
  ST -- ok --> PRL[Per-user rate limit]
  PRL --> H
  H --> OWN[Service layer: queries scoped to principal.userId; foreign ids => 404]
```

At boot, `AccessPolicyAuditor` walks every controller route and aborts startup if any lacks `@Public`, `@Authenticated` or
`@RequirePermissions`.

## Role-change rules (`role-policy.ts`)

1. Actor needs `users.manage`; nobody may change their own roles or status.
2. SUPER_ADMIN may manage any other user.
3. Otherwise: granted/revoked role rank must be **below** the actor's rank, the target must rank below the actor, and the role may
   not carry any permission the actor lacks.
4. The last SUPER_ADMIN can never be removed (serializable transaction; conflicts return a retryable 409).
5. Every attempt, allowed or denied, is audited.
