# Phase 11: admin console complete (2026-11-27)

Goal: staff can run the shop without SQL, a terminal or a developer. Every screen uses the shared admin pattern
(`AdminPage`, `useAdminQuery`, `withStepUp`) and is gated in `frontend/src/lib/admin-access.ts`; hiding is cosmetic and
every endpoint enforces its own permission.

## Bugs fixed (P1 "Frontend review: bugs", admin)

| Bug | Fix |
|---|---|
| A list stayed on an empty page after its last row was approved or deleted | `useClampedPage(meta, page, setPage)` (AdminKit) in every paged admin list |
| Inventory history kept its page when switching SKU | the panel is keyed by SKU |
| "Adjust" ignored the row's warehouse | the dialog gets the row's warehouse (fixed, shown read-only) |
| Categories screen: own sidebar and step-up prompt, loaded only with `products.update` | rebuilt on the shared pattern: readable with `products.read`, form with `products.update`, delete with `products.delete` |
| Variant save always sent price fields (needed `pricing.update`, audited as a price change) | the form sends only changed fields; the server treats a price field equal to the current value as untouched (no permission, no audit) |
| Order cancel form closed when the cancel failed | `act()` reports success; the form stays open with the reason typed |
| Role picker offered roles the caller cannot give | `GET /admin/roles` marks `assignable` per role (`canAssignRole`, role-policy, unit-tested to agree with `canChangeRole`) |

## New and extended endpoints

| Endpoint | Permission | Notes |
|---|---|---|
| `GET /admin/brands` (+ live product count), `POST`, `DELETE /admin/brands/:id` | products.read / update / delete | deleting keeps the products (no brand) |
| `GET /admin/products?ids=` | products.read | up to 60 ids (one page); names for the coupon product picker |
| `PATCH /admin/images/:id` | products.update | alt text, variant link (same product only), position (gallery renumbered 0..n-1 under a row lock) |
| `POST /admin/reviews/:id/take-down` | reviews.moderate | APPROVED -> REJECTED with a reason the author sees; conditional; audited |
| `GET /admin/returns?status=&orderId=` | orders.read | the order page links to its returns |
| `GET /admin/orders/:id/invoice` | orders.read | same document the customer gets |
| `GET /admin/orders/:id/credit-notes` | payments.read | finance documents |
| `GET /admin/credit-notes/export?from&to` | payments.read + step-up | GSTR-1-layout CSV (`orders/gstr1-export.ts`), at most a year and 5,000 notes, audited `finance.exported` |
| `GET /admin/refunds/export?from&to` | payments.read + step-up | refund reconciliation CSV with Razorpay ids (`orders/refund-export.ts`), audited |
| `POST /admin/refunds/:id/retry` | refunds.create + Idempotency-Key | see "Refund retry" |
| `GET /admin/customers?email|phone|order`, `GET /admin/customers/:id` | customers.read + step-up | see "Customer lookup" |
| `GET /admin/audit-logs`, `/actions` | audit.read + step-up | read through the reporting role (migration `20261127000800`) |
| `PATCH /admin/inventory/threshold`, `POST /admin/warehouses`, `PATCH /admin/warehouses/:code` | inventory.adjust | see "Warehouses" |
| `POST /admin/catalog/import` (multipart) | products.create + pricing.update + step-up | see "Catalogue import" |
| `GET /admin/contact-messages`, `POST /admin/contact-messages/:id/handled` | customers.read | support inbox; audited `contact.handled` |

## Design decisions

- **Refund retry.** A FAILED refund is retried as a NEW request in the name of the staff member retrying, so a different
  person must approve it (four-eyes, `refunds_human_approval_chk`). `refunds.retry_of_id` is UNIQUE (migration
  `20261127000700`): one retry per failed refund; a failed retry is retried by retrying it. A failed cancel refund is
  retried under the next cancel key (`cancel:<order>:<n>`) with the same reason, so `RefundService.recompute`
  completes the cancellation (and restocks once) when the retry is processed.
- **Customer lookup.** Exact identifiers only (email, phone, order number): it cannot browse the customer base. Email
  and phone come back masked (`common/utils/mask.ts`). Staff accounts are not shown (404). Every search and view is
  audited with the staff member, never with the searched value.
- **Audit-log viewer.** Reads through `ReportingDb` (read-only); the reporting role gets column grants on `audit_logs`
  WITHOUT `user_agent`. Periods are bounded (default 7 days, at most 92). Actor labels are added from the app database:
  a staff member's email, a customer's masked email. Metadata is shown as text.
- **CSV exports.** Every cell quoted; a cell starting with `= + - @`, tab or CR gets an apostrophe (CSV injection),
  except plain negative amounts (`common/utils/csv.ts`). Amounts from integer paise; India calendar dates. The
  accountant decides which GSTR-1 table (CDNUR or B2CS) applies.
- **Credit note with the refund email.** `CreditNoteService` adds `credit_note.issued` to the outbox in the note's own
  transaction; the notifications consumer sends the refund email on that event with the note attached as an HTML
  document (`identity/adapters/credit-note-document.ts`, everything escaped, no script). An order that was never invoiced
  gets its refund email on `refund.processed`, without a note. SES sends a raw MIME message only when there is an
  attachment (`identity/adapters/mime.ts`: no header injection, base64 parts).
- **Warehouses.** The default warehouse is always active (switching it off is refused); a warehouse holding stock or
  reservations cannot be switched off (its stock would vanish from availability); an inactive warehouse cannot become
  the default. Checked with the warehouse rows locked.
- **Catalogue import in the console.** Same service and rules as the CLI. Applying needs a dry run of the very same
  bytes and options by the same person within 30 minutes (ephemeral store); publishing needs products.publish; a file
  that sets stock needs inventory.adjust (the CLI now checks the same). Console files are capped at 2 MB / 500 products.

## Tests

Backend: unit (`gstr1-export`, `refund-export`, `mask`, `mime`, `credit-note-document`, `role-policy` `canAssignRole`,
channel adapter attachment, SES raw path) and e2e for every new endpoint with denied paths (catalog, contact,
customer-lookup, warehouses, audit-viewer, gst-credit-notes, refunds-returns, reviews-wishlist, authorization,
catalog-import, analytics grant check, pool-starvation for refund retries and image moves). Frontend:
`test-admin-screens.mjs` (fake backend) and `test-admin-real.mjs` (real backend, `npm run serve:browser`) drive every
new screen; `admin-access.spec.ts` covers the new gates; `finance.spec.ts` the month ranges.

## Open risks

- The refund reconciliation file is our side only; matching against Razorpay's settlement report is manual until the
  live account (and its settlement API) is available (Phase 13).
- An event processed before this release (a refund already PROCESSED whose `refund.processed` message is redelivered
  after deploy) on an invoiced order sends no refund email: the email now waits for `credit_note.issued`.
- The emailed credit note is HTML, not PDF; the customer prints or saves it. A PDF needs a renderer (P2).
- The admin inventory list still filters in memory (P2).
