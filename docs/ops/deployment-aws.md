# Deployment on AWS (plan and checklist — nothing here has been applied; there is no AWS access yet)

## Target
CloudFront (caches the catalogue; WAF with the managed and rate rules) → ALB (TLS, reachable only from CloudFront) → ECS
Fargate in private subnets:
- **api** (≥2 tasks): the root `Dockerfile` (`runtime` target), `node dist/main.js`, `BACKGROUND_JOBS_ENABLED=false`;
- **worker** (≥1 task, no load balancer): the SAME image with the command `node dist/worker.js` (outbox relay,
  reservation sweeper, payment/refund reconciliation, event consumers; safe on several tasks);
- **frontend** (≥2 tasks): `frontend/Dockerfile` (Next standalone, `node server.js`, port 3000); one image per
  environment because `NEXT_PUBLIC_*` and `API_INTERNAL_URL` are baked in at build time;
- **migrate** (one-off task): the root `Dockerfile` `migrate` target, the only task with the migrator URL.

Every task definition declares `runtimePlatform: { cpuArchitecture: ARM64, operatingSystemFamily: LINUX }` (Graviton;
the images are built with `--platform linux/arm64`, `DEPLOY_PLATFORM` in the deploy config; the deploy script refuses a
task definition that declares another CPU). Container names: `api`, `worker`, `frontend`, `migrate` (configurable);
other containers in a task (a log router) keep their own image. The worker container has NO health check (it has no
HTTP server; ECS ignores the image's `HEALTHCHECK`, so do not copy the API's container health check into it). ECR
repositories use IMMUTABLE tags: a commit's API/migrate images are built and scanned once (on the staging deploy) and the
same bytes are promoted to production; the frontend image is per environment and per build settings
(`<sha>-<env>-<hash of its build arguments>`), so changing a `NEXT_PUBLIC_*` value or `CSP_REPORT_ONLY` builds a new
image instead of reusing the old one. The deploy machine needs `docker buildx` (BuildKit): the root `Dockerfile` uses
`ADD --checksum`, which the classic builder refuses (`brew install docker-buildx`; `deploy.sh` checks it).

Data: RDS PostgreSQL 17 (Multi-AZ, encrypted, private, PITR) · ElastiCache Redis (auth + TLS) · Amazon MQ for RabbitMQ ·
S3 for product images (`STORAGE_DRIVER=s3`, `S3_BUCKET`, optional `S3_PREFIX`/`S3_KMS_KEY_ID`; a PRIVATE bucket with
block public access and versioning; objects are written with SSE and `If-None-Match`, so a key is never overwritten;
browsers get images through `/media/<key>` or CloudFront with origin access control, `MEDIA_BASE_URL`) · SES + MSG91 ·
Secrets Manager. Uploaded images are re-encoded with sharp (EXIF/GPS removed, at most 2400 px).

## What production refuses to start without (env validation)
HTTPS-only CORS origins, `DATABASE_SSL=true`, Turnstile captcha + a real secret (Cloudflare's test secrets are refused,
also on staging: create a Turnstile site with the staging hostname), breached-password check, Secure cookies, a real
notification driver (`NOTIFICATIONS_DRIVER=ses_msg91`), non-local image storage, an https `MEDIA_BASE_URL` and
`FRONTEND_BASE_URL` (not localhost), `REPORTING_DATABASE_URL`, `rediss://` and `amqps://` (TLS), Razorpay keys + webhook
secret, `SELLER_GSTIN`, `EVENT_BUS_DRIVER=rabbitmq`, no Swagger, no pretty logs, no `DATABASE_MIGRATION_URL` in the
app's environment, and a database login that could UPDATE/DELETE the append-only tables (checked at start-up, repair in
`docs/ops/database-roles.md`).

Database TLS: the app verifies the RDS certificate; the images carry Amazon's RDS CA bundle (pinned by checksum in the
root `Dockerfile`, `NODE_EXTRA_CA_CERTS`). Prisma's migration engine has its own TLS (it ignores that variable, does not
understand `sslmode=verify-full`, ignores `sslrootcert` and reads only the first certificate of a file): the migrate image
holds the region's RSA2048 root on its own (`/etc/ssl/certs/rds-root.pem`, build argument `RDS_CA_ROOT`, default
ap-south-1; the RDS instance must use the default CA `rds-ca-rsa2048-g1`) and refuses to run unless the migrator URL ends
with `?sslmode=require&sslaccept=strict&sslcert=/etc/ssl/certs/rds-root.pem` (`prisma.config.ts`). Verify on staging
that a migration with a wrong `sslcert` FAILS. The schema engine is downloaded when the image is built (no internet
access needed by the task).

## Checklist
1. Secrets in Secrets Manager (never in the image or repo). Task roles, least privilege: api and worker get SES send,
   `s3:PutObject`/`GetObject`/`DeleteObject` on `arn:aws:s3:::<bucket>/<prefix>*` and `s3:ListBucket` on the bucket
   with an `s3:prefix` condition (without it a missing object answers 403 instead of 404), `kms:GenerateDataKey`/
   `Decrypt` on the key when `S3_KMS_KEY_ID` is set, and read of their own secrets; frontend reads only
   `FRONTEND_SERVER_KEY`. Production also refuses a `MEDIA_BASE_URL` that is not https or points at localhost.
2. Roles: create `yalli_migrator`, `yalli_app`, `yalli_reporting` (docs/ops/database-roles.md). The API AND worker tasks
   (and any one-off CLI task such as the image import) get `DATABASE_URL` (app) and `REPORTING_DATABASE_URL` (production
   refuses to start without it, and refuses one that logs in as the app user); only the migration job gets the migrator
   URL.
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
4b. Frontend build (build arguments, see `frontend/Dockerfile`): `API_INTERNAL_URL` (the API's internal address, also
   used at runtime for server-side rendering), `NEXT_PUBLIC_BUSINESS_WEBSITE_URL` (https), `NEXT_PUBLIC_TURNSTILE_SITE_KEY`
   and the business details; runtime secret: `FRONTEND_SERVER_KEY`. Run `npm run check:launch` against the same values. The CSP (next.config.ts) allows Razorpay and Turnstile;
   test a real Razorpay checkout on staging, because the CSP only allows `*.razorpay.com`. Roll the CSP out in two steps:
   build staging once with `CSP_REPORT_ONLY=1` (in the frontend env file: nothing is blocked, everything is reported to
   `/api/v1/csp-reports`, log line "CSP violation"), run a full checkout, sign-up and contact form, confirm there are
   no violation lines, then rebuild without it. Production refuses report-only (launch check and `deploy.sh`). On https
   builds the storefront also sends HSTS (two years, subdomains), the same header as the API; neither asks for `preload`
   (an owner decision, hard to undo).
5. Health: liveness `/health/live`, readiness `/health/ready`. Graceful shutdown is enabled.
6. Background jobs AND the event consumers run in the worker service (`node dist/worker.js`); the API tasks set
   `BACKGROUND_JOBS_ENABLED=false` (they only publish) so a traffic spike does not slow the sweeper and a sweeper run
   does not take API connections. Jobs use `SKIP LOCKED` /
   conditional updates, so more than one worker task is safe.
6b. Redis outage: every Redis command is bounded (2 s) and a failure answers **503** (sessions, rate limits and challenges
   fail closed); alarm on it (log line "Redis commands are failing").
7. Razorpay: live keys, webhook → `https://<domain>/api/v1/webhooks/razorpay`, events payment.* and refund.*.
8. SES: verify the sender domain (SPF/DKIM/DMARC), request production access. MSG91: DLT sender + approved OTP template.
9. WAF managed rules + rate rule in front; CloudWatch alarms:
   - ALB 5xx (target and ELB) above 1% of requests for 5 minutes; p99 target response time above 2 s;
   - ECS running task count below desired (api, worker, frontend);
   - RDS: CPU > 80%, free storage < 20%, connections > 80% of max, replica lag;
   - outbox backlog (`outbox_events` not published after 5 minutes; a metric from the worker log) and the RabbitMQ DLQ
     depth > 0; ElastiCache evictions and CPU;
   - the log lines "Redis commands are failing", "A cancel refund was processed for an order that had shipped",
     "PAYMENT AMOUNT MISMATCH", "Outbox event stuck" (metric filters), and a sudden rise of "CSP violation" (the report endpoint is anonymous,
     so alarm on a rate, not on one line).
10. Backups, PITR and the restore drill (docs/ops/backup-restore.md); rotate keys (docs/ops/key-rotation.md).
11. No CI by the owner's decision (2026-11-19): deploy with `./scripts/deploy.sh <staging|production>` from a machine with
    Docker with buildx, the AWS CLI, jq, node and trivy. It refuses uncommitted changes (for production also a commit that is not on
    `origin/main`, and an unconfirmed run), runs `npm run check` and the launch check, builds the images for the tasks'
    CPU (or reuses a tag already in ECR), scans them (HIGH/CRITICAL stop it), pushes them, registers ALL new task
    revisions before changing anything (a failed registration stops it), runs the migration task and requires its
    `migrate` container to exit 0, then updates the services and verifies each one is really on its new revision (a
    rollout the circuit breaker reverted is a failure). Configuration: `deploy/<environment>.env` (git-ignored, a plain
    KEY=value file, see `deploy/example.env`). With `SITE_URL` set (it must equal the frontend's
    `NEXT_PUBLIC_BUSINESS_WEBSITE_URL`) it ends with `verify-site` (read-only checks of the live site; `--production` on
    production, where a report-only CSP fails) after a deploy; after a rollback a failure is reported but does not undo
    it (an older release may not meet today's checks). **Unverified against AWS: `--dry-run` runs only the local steps.**
12. Before launch: work through `docs/ops/launch-checklist.md` (Phase 14) and get it signed; then the cut-over runbook
    `docs/ops/go-live.md` (Phase 15: main hostname and the 301 from the other one keeping path and query, DNS host and
    certificate in us-east-1, every subdomain on HTTPS because of HSTS, rehearsal hostname behind a WAF IP rule, redirects,
    the stock take).
    A production deploy refuses an empty OpenCart redirect map.

## Rollback
Previous image + its schema: because migrations are additive, the previous image runs on the new schema.
`./scripts/deploy.sh <env> --rollback <earlier commit>` points the services back at the task revisions that ran that
commit's images (no build, no scan, no migration: the same bytes that ran before), and verifies the rollout. A destructive
migration needs a snapshot first and a tested restore.
