# Incident runbooks

First: **read the audit log and the logs by `requestId`.** Nothing here requires touching money by hand.

## A customer paid but the order is not PAID
Webhook missed or delayed. The worker re-checks unpaid orders with Razorpay every ~30 s. If it persists > 5 min:
check `webhook_inbox` (was the event received?), `payment_events`, and the Razorpay dashboard. Never mark an order paid by
hand: fix the cause; the next reconcile pass applies the payment (amount and currency are verified).

## Webhooks are failing (401 / 5xx at Razorpay)
401 = signature mismatch → the webhook secret differs (see key-rotation). 5xx/503 = we could not ask Razorpay (their outage or
our egress): Razorpay retries; no data is lost; the reconcile worker backs it up.

## "PAYMENT AMOUNT MISMATCH" (alarm)
Razorpay reports a payment for another amount than the order (or another currency). The order is NOT marked paid; the
payment gets `failure_code = AMOUNT_MISMATCH` and is reported ONCE (audit `payment.amount_mismatch`, one log line), then
left alone by the reconcile worker; the unpaid order expires as usual (stock back on the shelf). If Razorpay shows the
money as CAPTURED, refund it there in full (Razorpay dashboard → the payment → Refund), and note it in the order's
history; an authorization that was never captured lapses by itself. It is never refunded automatically: that would
bypass the refund rules (capacity, two people).

## Refund stuck (APPROVED / PROCESSING for > 10 min)
The worker resolves it by looking the refund up at Razorpay by receipt before it ever resends. If the order shows
`REFUND_PENDING` with a FAILED refund after a **cancellation**, the provider rejected the automatic refund (often: insufficient
balance). Fund the account, then create a manual refund for the full amount (two people: one requests, one approves).
The goods are already back in stock; the order stays `REFUND_PENDING` until the money is returned.

## Outbox backlog / events not delivered
`SELECT count(*), min(created_at) FROM outbox_events WHERE published_at IS NULL;` — rows retry with backoff up to 1 hour.
If RabbitMQ is down they wait safely. Messages that fail a consumer 5 times land in `yalli.<consumer>.dlq`: inspect, fix the
cause, shovel them back. Consumers de-duplicate, so replays are safe.

## Suspected account takeover
Revoke the user's sessions, force a password reset, check `audit_logs` for `auth.mfa.locked`, `auth.login.failure`, new-device
events. MFA brute-force attempts are limited to 10 failures per account per 15 minutes across all logins.

## Many customers locked out
Locks last at most 1 hour and are caused by wrong passwords on that account. A burst across many accounts means credential
stuffing: tighten the per-IP limits, enable captcha (production requires Turnstile), watch `auth.account.locked`.

## Stock looks wrong
`inventory_movements` is the ledger (every change, with actor and reference). `on_hand - reserved` = sellable.
Expired reservations are released by the worker. Adjust only through the admin inventory endpoint.

## Database / reporting
Reports are slow → they use their own small pool and 10 s limit (`REPORTING_DATABASE_URL`); check indexes `orders_paid_at_idx`.
After any restore: run the invariant checks from `scripts/dr-drill.sh`.

## Behind a load balancer: rate limits behave strangely
`TRUST_PROXY_HOPS` must equal the number of trusted proxies in front of the app (CDN + load balancer = 2). Too low: every
customer shares one IP bucket. Too high: clients can spoof `X-Forwarded-For` and dodge limits.
