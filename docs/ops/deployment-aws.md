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
4. `TRUST_PROXY_HOPS` = number of proxies in front (CloudFront + ALB = 2).
5. Health: liveness `/health/live`, readiness `/health/ready`. Graceful shutdown is enabled.
6. Exactly one background worker is not required: jobs use `SKIP LOCKED`/conditional updates and are safe on every instance.
7. Razorpay: live keys, webhook → `https://<domain>/api/v1/webhooks/razorpay`, events payment.* and refund.*.
8. SES: verify the sender domain (SPF/DKIM/DMARC), request production access. MSG91: DLT sender + approved OTP template.
9. WAF managed rules + rate rule in front; CloudWatch alarms on 5xx, p99 latency, DB connections, outbox backlog, DLQ depth.
10. Backups, PITR and the restore drill (docs/ops/backup-restore.md); rotate keys (docs/ops/key-rotation.md).
11. Pin GitHub Actions to SHAs after the first push; enable branch protection requiring the CI jobs.

## Rollback
Previous image + its schema: because migrations are additive, the previous image runs on the new schema. A destructive
migration needs a snapshot first and a tested restore.
