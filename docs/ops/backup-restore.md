# Backup and restore

**Targets (proposed, confirm with the business):** RPO 5 minutes, RTO 1 hour.

## Production (RDS PostgreSQL) — unverified, needs AWS
- Automated backups on, retention 14+ days (point-in-time recovery to any second; gives the 5-minute RPO).
- Multi-AZ for failover; storage encrypted with KMS; deletion protection on.
- A manual snapshot before every migration that is not purely additive.
- Copy snapshots to a second region (monthly at minimum).
- Redis and RabbitMQ hold no authoritative data: rebuild them. PostgreSQL is the only thing that must survive.
  After restoring PostgreSQL, unpublished outbox rows are re-sent automatically and consumers de-duplicate.

## Restore procedure
1. Stop writers (scale the API to zero; keep the worker off).
2. Restore the snapshot / PITR to a NEW instance; do not overwrite the damaged one.
3. Run the integrity checks from `scripts/dr-drill.sh` ("Money and stock invariants") against the restored database.
4. Point the API at it (new `DATABASE_URL`), start one instance, check `/health/ready`.
5. **Reconcile with Razorpay**: payments taken after the restore point exist at Razorpay but not in your database.
   The reconciliation worker finds them (it asks Razorpay about every unpaid order), and any capture for an order that can no
   longer be fulfilled is refunded automatically. Review the audit log for `payment.*` after the worker has run.
6. Scale up. Announce.

## DR drill (local, runnable now)
```bash
docker compose up -d postgres      # with data present, e.g. after ./scripts/verify-docker.sh
./scripts/dr-drill.sh
```
It backs up, restores into a scratch database, compares every table row for row, checks constraints/triggers/indexes survived,
and re-runs the money/stock invariants on the restored copy. It prints the measured restore time. Repeat the same drill against
a staging RDS restore quarterly, and record the time.
