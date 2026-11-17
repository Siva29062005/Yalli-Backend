# Key and secret rotation

| Secret | How to rotate | User impact |
|---|---|---|
| **JWT signing key** (`JWT_KEY_ID`, `JWT_PRIVATE_KEY_B64`) | New key id + key as current; put the OLD public key in `JWT_RETIRED_PUBLIC_KEYS_JSON` (`{"old-kid":"<base64 PEM>"}`); deploy. After 15 minutes (the access-token lifetime) remove the retired entry. | None. |
| **MFA encryption key** (`MFA_ENCRYPTION_KEY_*`) | 1. New key as current (`MFA_ENCRYPTION_KEY_B64`, new `MFA_ENCRYPTION_KEY_ID`); old key into `MFA_RETIRED_KEYS_JSON` (`{"k1":"<base64 32 bytes>"}`). 2. Deploy (retired keys still decrypt, so nobody is locked out). 3. `node dist/cli/rotate-mfa-key.js` (dry run), then `--apply`. Safe on a live site and to re-run. 4. When `alreadyCurrent == scanned`, remove the retired key. | None. **Never** change the key without step 1: every MFA user would be locked out. |
| **Razorpay key / webhook secret** | Create new keys in the dashboard, update the secret store, deploy, then revoke the old ones. Webhook secret: set the new one in Razorpay and the app in the same window (deliveries between are rejected with 401 and retried by Razorpay). | None / a few retried webhooks. |
| **Database passwords** | Change the role password, update the secret store, restart. `yalli_migrator` is only used during deploys. | Brief reconnect. |
| **Redis / RabbitMQ passwords** | Update both sides together, restart. Rate-limit counters and in-flight MFA challenges are lost (users retry). | Re-login prompts. |
| **SES / MSG91** | SES uses the IAM role (nothing to rotate in the app). MSG91 key: update the secret store, restart. | None. |

Emergency (suspected key leak): rotate immediately, then `UPDATE`-free response: revoke sessions with the admin tooling
(`POST /auth/logout-all` per user, or truncate the session table in a maintenance window), and review `audit_logs`.
