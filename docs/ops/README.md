# Operations

| Document | Use it when |
|---|---|
| [deployment-aws.md](deployment-aws.md) | Preparing the first production deployment; what needs AWS access |
| [database-roles.md](database-roles.md) | Creating the three database roles and their grants |
| [backup-restore.md](backup-restore.md) | Backups, restore, and the DR drill (`scripts/dr-drill.sh`) |
| [key-rotation.md](key-rotation.md) | Rotating JWT keys, the MFA key, Razorpay and database secrets |
| [incident-runbooks.md](incident-runbooks.md) | Something is wrong: payments, webhooks, queues, account takeover |
| [load-testing.md](load-testing.md) | Running `scripts/load/run.mjs` against a staging instance |
| [catalogue-migration.md](catalogue-migration.md) | Moving the OpenCart catalogue, images and business details to the new shop |

Nothing here was exercised on AWS (no access yet). Every procedure marked **unverified** must be rehearsed on staging first.
