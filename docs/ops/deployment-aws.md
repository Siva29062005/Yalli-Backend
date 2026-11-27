# Deployment on AWS (plan and checklist — nothing here has been applied; there is no AWS access yet)

## Target
CloudFront (caches the catalogue) → ALB (TLS, WAF) → ECS Fargate API (≥2 tasks, private subnets) → RDS PostgreSQL 17
(Multi-AZ, encrypted, private) · ElastiCache Redis (auth + TLS) · Amazon MQ for RabbitMQ · S3 (product images; the app must
get an S3 `ObjectStorage` implementation — the local-disk one is refused in production) · SES + MSG91 · Secrets Manager.

## What production refuses to start without (env validation)
HTTPS-only CORS origins, `DATABASE_SSL=true`, Turnstile captcha + secret, breached-password check, Secure cookies, a real
notification driver (`NOTIFICATIONS_DRIVER=ses_msg91`), non-local image storage, Razorpay keys + webhook secret, `SELLER_GSTIN`,
`EVENT_BUS_DRIVER=rabbitmq`, no Swagger, no pretty logs.

## Checklist
1. Secrets in Secrets Manager (never in the image or repo); task role has SES send + secret read only.
2. Roles: create `yalli_migrator`, `yalli_app`, `yalli_reporting` (docs/ops/database-roles.md). The API task gets `DATABASE_URL`
   (app) and `REPORTING_DATABASE_URL`; only the migration job gets the migrator URL.
3. Migrations run as a one-off task BEFORE the new image rolls out; keep them additive (expand → deploy → contract).
4. `TRUST_PROXY_HOPS` = number of proxies in front (CloudFront + ALB = 2; production refuses 0). The browser's
   `/api/v1/*` calls must reach the API through CloudFront and the ALB only: an ALB path rule `/api/v1/*` -> API target
   group (the Next.js rewrite is for local development). If they went through the Next server, the client IP would be
   lost (Next does not append to `X-Forwarded-For`) and per-IP limits would hit every shopper at once. Lock the ALB to
   CloudFront (managed prefix list / secret header) so `X-Forwarded-For` cannot be forged by calling the ALB directly.
   The Next server's own server-side catalogue reads go to the API's internal address with `FRONTEND_SERVER_KEY`
   (same secret in both services, from Secrets Manager): they get a separate budget (6000/min) instead of the per-IP
   limits. Per-visitor limits for page views belong in a WAF rate-based rule at CloudFront.
   The single `frontend-server` budget is shared by every frontend replica; a WAF rate-based rule per client IP at
   CloudFront is therefore a LAUNCH REQUIREMENT, otherwise one visitor requesting many uncached pages can use it up.
   Deploy the backend before the frontend (the browser refreshes only on the backend's `ACCESS_TOKEN_INVALID`).
4b. Frontend build: set `NEXT_PUBLIC_BUSINESS_WEBSITE_URL` (https), `NEXT_PUBLIC_TURNSTILE_SITE_KEY` and the business
   details; runtime: `API_INTERNAL_URL`, `FRONTEND_SERVER_KEY`. The CSP (next.config.ts) allows Razorpay and Turnstile;
   test a real Razorpay checkout on staging, because the CSP only allows `*.razorpay.com`.
5. Health: liveness `/health/live`, readiness `/health/ready`. Graceful shutdown is enabled.
6. Exactly one background worker is not required: jobs use `SKIP LOCKED`/conditional updates and are safe on every instance.
7. Razorpay: live keys, webhook → `https://<domain>/api/v1/webhooks/razorpay`, events payment.* and refund.*.
8. SES: verify the sender domain (SPF/DKIM/DMARC), request production access. MSG91: DLT sender + approved OTP template.
9. WAF managed rules + rate rule in front; CloudWatch alarms on 5xx, p99 latency, DB connections, outbox backlog, DLQ depth.
10. Backups, PITR and the restore drill (docs/ops/backup-restore.md); rotate keys (docs/ops/key-rotation.md).
11. No CI by the owner's decision (2026-11-19): run `npm run check` (backend and frontend) locally before every deploy; the
    deploy script planned in Phase 13 of `docs/ROADMAP.md` refuses to run without it.

## Rollback
Previous image + its schema: because migrations are additive, the previous image runs on the new schema. A destructive
migration needs a snapshot first and a tested restore.
