# Go-live: replacing the OpenCart store (Phase 15)

For the owner and whoever runs the deploy. Start only when `docs/ops/launch-checklist.md` is signed (Phase 14). Times
below are relative to the cut-over (T0). Nothing here migrates customer accounts: passwords cannot be moved safely, so
customers create new accounts (the sign-in and sign-up pages say so when built with `NEXT_PUBLIC_OLD_STORE_NOTICE=1`).

## Decisions first (owner)

| Decision | Notes |
|---|---|
| Main address: `yalli.in` or `www.yalli.in` | The other one must answer with a 301 to the main one (a CloudFront Function on that hostname, or a small second distribution). Both names on the certificate. `NEXT_PUBLIC_BUSINESS_WEBSITE_URL`, `FRONTEND_BASE_URL`, `CORS_ALLOWED_ORIGINS` and `SITE_URL` use the main one. |
| Cut-over date and a freeze window | A weekday morning (India time) with low traffic; about 2 hours. |
| How customers are told | A notice on the old site from T-7 days; the sign-in/sign-up notice on the new site. Emailing old customers about the move: ask the lawyer (consent). |
| What happens to the OpenCart data | Orders and invoices are GST records (keep them as long as the accountant says, usually 72 months from the annual return's due date); customer accounts and addresses are deleted when no longer needed. Keep one encrypted, offline database copy. |
| Rollback cut-off | Until when going back to OpenCart is allowed (for example the first 4 hours, before real orders accumulate). After it, fix forward. |

## T-14 days

1. Lower the DNS TTL of the main and the other hostname to 300 seconds (the switch, and a fallback, then take minutes).
2. Search Console: verify the domain (DNS TXT record) if it is not verified yet. Bing Webmaster Tools: import from Search
   Console.
3. Save the list of OLD addresses that matter, one per line, into `old-urls.txt` (not secret; keep it with the migration
   files):
   - every address in the old store's sitemap (OpenCart 3: `index.php?route=extension/feed/google_sitemap`, if the feed
     is enabled), and
   - the Search Console "Pages" report (top pages by clicks), exported.
4. Final catalogue conversion from a fresh export (`docs/ops/catalogue-migration.md`), import on PRODUCTION as drafts,
   review, publish.
5. Redirect map: copy `migration/redirects.json` to `frontend/src/data/legacy-redirects.json` and commit it.
   - It covers products and categories (OpenCart ids and SEO keywords) and brands with products.
   - Information pages use OpenCart's default ids and keywords (3 privacy, 4 about_us → contact, 5 terms, 6 delivery →
     shipping). Open the old site's information pages: if their `information_id` or SEO keyword differs, add entries
     to the file, e.g. `{ "kind": "information", "id": "7", "keyword": "returns-policy", "to": "/returns" }`.
   - Destinations must be plain paths on this site (`/products/…`, `/catalog/…`, `/brands/…`, a page): anything else
     is ignored, and `npm run check` fails if the file has such an entry.
   - A production deploy refuses an empty map.
6. Rehearsal: deploy production (`./scripts/deploy.sh production`, with `SITE_URL` left out of `deploy/production.env`
   until T0: before the DNS switch that address is still the old store) and reach it under a temporary hostname such as
   `new.yalli.in` (an extra name on the CloudFront distribution and the certificate). Add `https://new.yalli.in` to
   `CORS_ALLOWED_ORIGINS` for the rehearsal (the captcha's hostname check and the CSRF origin check use that list), and
   to the Turnstile site's hostnames and Razorpay's website settings.
7. On the rehearsal hostname:
   - `npm run verify:site -- --url https://new.yalli.in --production --canonical https://yalli.in` (0 failed);
   - `npm run verify:redirects -- --site https://new.yalli.in --urls old-urls.txt` (0 failed; for each failure add the
     address to the map, commit, deploy again);
   - the owner places one real order with a live payment, ships it, returns it and refunds it (email, SMS, invoice and
     credit note arrive).

## T-1 day

- The notice on the old site gives the time of the switch.
- Export the current stock from OpenCart (a report or a product list with quantities) to set it on the new store at T0.

## Cut-over (T0), in this order

1. **Old store: maintenance mode** (System → Settings → Server → Maintenance Mode). No new orders from here on. Note the
   last order number.
2. **Stock:** set each product's stock on the new store from the final OpenCart quantities (Admin → Inventory → Adjust,
   reason "opening stock at go-live"; stock always goes through the ledger).
3. **DNS:** point the main and the other hostname at CloudFront (alias records). With the 300-second TTL most visitors
   arrive within minutes.
4. **Check** (and from now on set `SITE_URL=https://yalli.in` in `deploy/production.env`, so every deploy checks the site):
   - `npm run verify:site -- --url https://yalli.in --production`
   - `npm run verify:redirects -- --site https://yalli.in --urls old-urls.txt`
   - the other hostname answers with a 301 to the main one;
   - a test sign-up (email and SMS arrive) and a live payment (refund it).
5. **Search engines:** Search Console → Sitemaps → submit `https://yalli.in/sitemap.xml` (remove an old sitemap address if
   one was submitted); the same in Bing Webmaster Tools.
6. **Old store:** keep it running but NOT on the public domain (for example `old.yalli.in` behind an IP allow-list or a
   password) to ship or refund its open orders and to answer questions about them. Old order links reach the new site,
   whose redirects handle them.

## First 72 hours

- Alarms (`docs/ops/deployment-aws.md`): 5xx, p99, task counts, RDS, outbox backlog, DLQ, Redis, "PAYMENT AMOUNT
  MISMATCH", a rise in "CSP violation".
- Payments: Razorpay dashboard against orders marked PAID, every few hours on day one.
- 404s: CloudFront/frontend logs and Search Console "Not found": an old address that matters and is missing from the map
  gets an entry in `legacy-redirects.json` and a deploy.
- The support inbox and contact-form messages (Admin → Messages): customers looking for their old account.

## Rolling back

- A bad release: `./scripts/deploy.sh production --rollback <previous commit>`.
- Back to OpenCart (only before the rollback cut-off): point DNS back to the old server and take it out of maintenance.
  Orders already paid on the new store are still fulfilled from the new console (the money is in Razorpay).

## After two weeks

- DNS TTL back to 3600 seconds.
- Remove the rehearsal hostname from the distribution, the certificate, `CORS_ALLOWED_ORIGINS`, Turnstile and Razorpay.
- Keep watching Search Console "Pages" weekly for a month.
- After about three months, build without `NEXT_PUBLIC_OLD_STORE_NOTICE`.
- OpenCart data: as decided above.
