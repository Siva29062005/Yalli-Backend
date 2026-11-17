# Phase 5 — Checkout, orders, payments, refunds, returns, events (implemented)

Everything here is verified by automated tests against a real PostgreSQL, **except** the live Razorpay API and a live
RabbitMQ broker (see "Not yet verified"). Razorpay is exercised through an in-process simulator that speaks the real API
shapes; RabbitMQ topology and retry logic are unit-tested with a fake channel and verified end-to-end by `scripts/verify-docker.sh`.

## Flow

```mermaid
sequenceDiagram
  autonumber
  participant B as Browser
  participant A as API
  participant P as PostgreSQL
  participant R as Razorpay
  participant Q as RabbitMQ
  B->>A: POST /checkout/orders (Idempotency-Key)
  A->>P: ONE tx: lock cart, re-price, order + snapshots, reserve stock, redeem coupon, empty cart, outbox
  A-->>B: order INVENTORY_RESERVED
  B->>A: POST /orders/:id/payments
  A->>R: create order (exact paise)
  A-->>B: keyId + providerOrderId
  B->>R: pay on hosted checkout (card/UPI never touches us)
  R->>A: webhook payment.captured (HMAC over RAW body)
  A->>A: verify signature, dedupe event id
  A->>R: GET payment (the provider's truth, not the payload's claim)
  A->>P: ONE tx: capture + order PAID + stock COMMIT + outbox
  B->>A: POST /orders/:id/payments/confirm (signature + provider fetch; same code path)
  A-)Q: relay publishes outbox events (after commit)
  Q-)A: consumer sends the confirmation (de-duplicated)
```

## Money and stock invariants

| # | Invariant | Application | Database | Test |
|---|---|---|---|---|
| 1 | An order is PAID only after trusted payment confirmation | `applyProviderPayment` is the only path; facts come from the provider API | `orders_paid_chk` (PAID needs `paid_at`) | forged/claimed/replayed/mismatched signals |
| 2 | The paid amount equals the order total | exact amount + currency check, else `mismatch` + audit | `payments_captured_chk` | wrong amount / wrong currency |
| 3 | Never two live payments for one order (no double charge) | one provider order reused for retries; claim lock on creation | `payments_one_live_per_order_uniq` | concurrent initiations ⇒ 1 provider order |
| 4 | A webhook event is processed once | unique event id in the same tx as the effect | `webhook_inbox` unique | replay ×3, 5 parallel, distinct ids |
| 5 | Webhooks are authentic | HMAC-SHA256 over the raw bytes, constant-time, fail-closed | — | forged / altered / re-serialised / no secret |
| 6 | Order/payment states follow the machine | `assertOrderTransition`, `assertPaymentTransition` under row locks | — | 28 state-machine tests |
| 7 | A refund can never exceed what was captured | conditional `UPDATE … refunded + x <= captured` | `payments_refunded_chk` | 12 parallel 25 % requests ⇒ 4 accepted |
| 8 | Refunds need two people | approver ≠ requester | `refunds_four_eyes_chk` | self-approval 403; 3 racing approvers ⇒ 1 provider call |
| 9 | A refund is never sent twice or lost | unique `receipt` + provider lookup before any retry | unique `idempotency_key`, `receipt` | timeout before/after effect, definitive reject |
| 10 | Money for an order we cannot fulfil goes back | late capture / out-of-stock ⇒ automatic full refund | — | cancelled, expired and sold-out cases |
| 11 | Orders are snapshots | items copied at purchase | `order_items` immutable trigger | price/name change after purchase |
| 12 | Ledgers are immutable | append-only tables | triggers + revoked UPDATE/DELETE | edit/delete attempts rejected |
| 13 | Stock is committed once, all-or-nothing | `commitInTx` validates every line first | reservations unique, inventory CHECKs | hold lapsed / partly swept |
| 14 | Retried requests are safe | `Idempotency-Key` (checkout, payment start, refund request) | `idempotency_records` unique | replay, reuse, in-flight, crash recovery |
| 15 | Events exist iff the change committed | transactional outbox, relay publishes after commit | — | rolled-back checkout leaves no event |
| 16 | Delivery is at-least-once but effects happen once | `processed_messages` in the consumer's tx | PK (consumer, message) | duplicate delivery ⇒ 1 email |

## Order states

`CREATED → INVENTORY_RESERVED → PAYMENT_PENDING → PAID → PROCESSING → SHIPPED → DELIVERED`, plus `PAYMENT_FAILED`
(retry or a later success is legal), `CANCELLED` (unpaid only), `REFUND_PENDING → PARTIALLY_REFUNDED / REFUNDED`,
and `RETURN_REQUESTED → RETURN_APPROVED → RETURNED`. A **paid** order is cancelled *through* a refund: stock is restocked,
a full refund is raised automatically, and the order ends `REFUNDED`. A shipped order cannot be cancelled (return instead).
(`INVENTORY_RELEASED` from the proposal is not a state: release is recorded by `inventory_released_at` in the same transaction.)

## Endpoints (`/api/v1`)

Customer (authenticated, ownership-scoped): `POST /checkout/quote`, `POST /checkout/orders` (**Idempotency-Key required**),
`GET /orders`, `GET /orders/:id`, `POST /orders/:id/cancel`, `GET /orders/:id/invoice`, `POST /orders/:id/payments`
(**Idempotency-Key**), `POST /orders/:id/payments/confirm`, `GET /orders/:id/payment-status`, `POST /orders/:id/returns`, `GET /returns`.

Provider (signature-authenticated): `POST /webhooks/razorpay`.

Admin (permission + MFA step-up + audit): `GET /admin/orders[/:id]` (`orders.read`), `GET /admin/orders/:id/payments`
(`payments.read`), `POST /admin/orders/:id/fulfilment`, `POST /admin/orders/:id/cancel`, `GET /admin/returns`,
`POST /admin/returns/:id/decision|received` (`orders.update`), `GET /admin/refunds` (`payments.read`),
`POST /admin/refunds` (`refunds.create`, **Idempotency-Key**), `POST /admin/refunds/:id/approve|reject` (`refunds.approve`).

## Operating it

- **Razorpay setup**: create TEST keys; set `RAZORPAY_KEY_ID/SECRET/WEBHOOK_SECRET`; in the dashboard add the webhook
  `https://<api-host>/api/v1/webhooks/razorpay` with events `payment.authorized`, `payment.captured`, `payment.failed`,
  `refund.processed`, `refund.failed` and the same secret. Enable auto-capture, or rely on the built-in capture-on-authorize.
- **Background safety nets** (every 30 s, safe on many instances): expire unpaid orders **only after asking the provider**
  (never cancels an order that might be paid; skips on provider outage), re-check open payments for missed webhooks and
  payments made after cancellation, finish stuck refunds, release expired stock holds, purge expired idempotency keys/carts.
  In production run these in a dedicated worker process (`BACKGROUND_JOBS_ENABLED`).
- **Alerts to create** (log lines / audit actions / metrics): `PAYMENT AMOUNT MISMATCH`, `payment.amount_mismatch`,
  `payment.webhook_rejected` spikes, refunds stuck in `PROCESSING` > 10 min, `FAILED` refunds, outbox backlog
  (`OutboxRelay.backlog()`), messages in `*.dlq` queues, `payment.duplicate_capture`, inventory `reconcile()` mismatches.
- **Replays/redeliveries** are normal: duplicates are acknowledged with 200 and ignored.

## Assumptions to confirm

1. **Return window 7 days** from delivery (`RETURN_WINDOW_DAYS`). Unopened returns are restocked; opened ones are not.
2. **Refund policy**: a cancelled paid order is refunded in full automatically; goodwill/return refunds need a second approver (no amount threshold).
3. A coupon used on an order that is **cancelled unpaid** is given back; on a **paid** order it stays used even if refunded.
4. Payment window **30 minutes** (`PAYMENT_WINDOW_MINUTES`). Shipping is **₹0** until Phase 6.
5. The invoice is JSON; it is a valid *tax* invoice only once `SELLER_GSTIN` is configured. PDF rendering and invoice-number series per financial year are not built.
6. Returns: one open return per order; goods-received creates a refund *request* for the item's share of what was paid.

## Not yet verified (honest list)

- **Live Razorpay**: the adapter follows Razorpay's documented API (orders, payments, capture, refunds, webhook and checkout
  signatures) and is tested against a simulator, never against real Razorpay. Test it with sandbox keys before launch:
  one successful payment, one failed payment, one refund, one duplicate webhook delivery from the dashboard's "resend".
- **Razorpay refund idempotency** is by our `receipt`; Razorpay does not de-duplicate on it, so the guarantee comes from our
  own state machine + lookup-before-retry (tested), not from the provider.
- **RabbitMQ**: topology/retry/DLQ logic is unit-tested with a fake channel; the real broker round trip is checked by `scripts/verify-docker.sh`.

## Known limitations and risks

1. **An abandoned provider order** (provider call timed out after succeeding, id never returned) is harmless but remains open at Razorpay.
2. Order/payment **status changes by admins** (`fulfilment`) are manual until Phase 6 couriers; no shipment records yet.
3. **Partial cancellation / partial shipments** are not supported; refunds can be partial, orders cannot be split.
4. The **return refund** is computed per line (`line total × qty / line qty`, rounded down): one paisa can stay unrefunded on odd splits; finance can add a goodwill refund.
5. `GET /admin/refunds` lists refunds but there is no dashboard or CSV export; reconciliation against the Razorpay settlement report is manual.
6. Webhook processing performs one provider API call per payment event; a Razorpay outage returns 503 and relies on its retries (up to 24 h) plus our reconciliation.
7. Card/UPI data never reaches our servers or database (hosted checkout), and webhook payloads are reduced to ids, amounts and status before storage; PCI scope remains for the storefront page that embeds the checkout (SAQ A is the target; no compliance is claimed without an assessment).
8. The consumer sends notifications inside its transaction: a crash after sending but before commit can send twice (acceptable for emails, never for money).
9. `payments.attempt` > 1 only occurs if the first provider order creation was definitively rejected.
