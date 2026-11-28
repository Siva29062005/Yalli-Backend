# Go-live: replacing the OpenCart store (Phase 15)

For the owner and whoever runs the deploy. Start only when `docs/ops/launch-checklist.md` is signed (Phase 14). Times
below are relative to the cut-over (T0). Customer accounts are not migrated: passwords cannot be moved safely, so
customers create new accounts (the sign-in and sign-up pages say so in builds with `NEXT_PUBLIC_OLD_STORE_NOTICE=1`).

The commands below run from the repository root after `npm run build` (they run the compiled files); keep the migration
files in `migration/` there (git-ignored).

## Decisions first (owner)

| Decision | Notes |
|---|---|
| Main address: `yalli.in` or `www.yalli.in` | The OTHER one answers with a 301 to the main one, keeping the path AND the query string (old links such as `index.php?route=product/product&product_id=42` depend on it). `NEXT_PUBLIC_BUSINESS_WEBSITE_URL`, `FRONTEND_BASE_URL`, `CORS_ALLOWED_ORIGINS` and `SITE_URL` use the main one. |
| DNS host | The bare domain must point at CloudFront: Route 53 (alias record) or a DNS provider with ALIAS/CNAME flattening. If the nameservers move, do it at least 3 days before T0 (the parent zone's NS records keep their own, longer TTL) and copy EVERY record first, especially mail (MX, SPF, DKIM, DMARC). |
| Certificate | ACM in us-east-1 (required by CloudFront) covering the main, the other and the rehearsal hostname (`new.yalli.in`). |
| Subdomains and HSTS | From T0 the site sends `Strict-Transport-Security; includeSubDomains` for two years: every `*.yalli.in` name (old., mail., webmail., cpanel. …) must serve valid HTTPS or stop being used. List them now. |
| Cut-over date and a freeze window | A weekday morning (India time) with low traffic; about 2 hours. Ask the owner not to change products in OpenCart after T-14 (changes have to be repeated). |
| How customers are told | A notice on the old site from T-7 days; the sign-in/sign-up notice on the new site. Emailing old customers about the move: ask the lawyer (consent). |
| What happens to the OpenCart data | Orders and invoices are GST records (keep them as long as the accountant says, usually 72 months from the annual return's due date); customer accounts and addresses are deleted when no longer needed. Keep one encrypted, offline database copy. |
| Rollback cut-off | Until when going back to OpenCart is allowed (for example the first 4 hours). After it, fix forward. |

The other hostname's redirect, as a CloudFront Function (viewer request) on a distribution for that name:

```js
function handler(event) {
  var r = event.request, qs = [];
  for (var k in r.querystring) {
    var v = r.querystring[k];
    (v.multiValue || [v]).forEach(function (x) {
      qs.push(encodeURIComponent(k) + (x.value === '' ? '' : '=' + encodeURIComponent(x.value)));
    });
  }
  return { statusCode: 301, statusDescription: 'Moved Permanently',
    headers: { location: { value: 'https://yalli.in' + r.uri + (qs.length ? '?' + qs.join('&') : '') } } };
}
```

## T-14 days

1. Lower the DNS TTL of the main and the other hostname to 300 seconds.
2. Search Console: verify the domain (DNS TXT record) if it is not verified yet; Bing Webmaster Tools: import from it.
3. Save the OLD addresses that matter into `migration/old-urls.txt`: the old sitemap (OpenCart 3:
   `index.php?route=extension/feed/google_sitemap`, if enabled; paste the XML as it is) and Search Console →
   Performance → Pages → Export as CSV (the first column is used, the header line is skipped). Plain URLs work too.
4. Convert from a fresh export (`docs/ops/catalogue-migration.md`), then the redirect map:
   - copy `migration/redirects.json` to `frontend/src/data/legacy-redirects.json` (products, categories, brands with an
     enabled product);
   - hand-written entries go into `frontend/src/data/legacy-redirects-extra.json` (copying a new converter file never
     overwrites them, and they win). Information pages use OpenCart's default ids and keywords (3 privacy, 4 about_us →
     contact, 5 terms, 6 delivery → shipping): open the old site's information pages and add an entry for each that
     differs, e.g. `{ "kind": "information", "id": "7", "keyword": "returns-policy", "to": "/returns" }`;
   - destinations must be product/category/brand pages or one of the shop's fixed pages; anything else is ignored and
     `npm run check` fails;
   - commit both files (a production deploy refuses an empty map).
5. Production settings for the rehearsal (in the task definitions / Secrets Manager, back to the main domain at T0):
   - `FRONTEND_BASE_URL=https://new.yalli.in` (emailed verification and reset links must not point at the old store:
     they would fail, and their tokens would land in the old server's logs);
   - `https://new.yalli.in` added to `CORS_ALLOWED_ORIGINS` (the captcha hostname check and the CSRF origin check use
     it), to the Turnstile site's hostnames and to Razorpay's website settings;
   - a Razorpay webhook for the NEW store to `https://new.yalli.in/api/v1/webhooks/razorpay` (a second webhook: the old
     store keeps its own);
   - a WAF rule that BLOCKS every request whose Host is not the main hostname unless it comes from the owner's IP
     addresses: the rehearsal hostname and the `*.cloudfront.net` name are then not usable by the public (the catalogue
     is published there, and the hostname shows up in certificate logs);
   - the frontend env file with `NEXT_PUBLIC_OLD_STORE_NOTICE=1`.
6. Deploy production (`./scripts/deploy.sh production`, `SITE_URL` left out of `deploy/production.env` until T0:
   before the DNS switch that address is still the old store).
7. Import on production (`npm run import:catalog -- --file migration/catalog.json --apply --as <email> --publish`),
   review in the console (`docs/ops/catalogue-migration.md`, images too).
8. Rehearse on `https://new.yalli.in`:
   - `npm run verify:site -- --url https://new.yalli.in --production --canonical https://yalli.in` (0 failed);
   - `npm run verify:redirects -- --site https://new.yalli.in --urls migration/old-urls.txt` (0 failed; for each
     failure add the address to `legacy-redirects-extra.json`, commit, deploy again; a brand you created in the console
     before the import keeps its own address, so its converter entry may need a correction there);
   - the owner registers (email and SMS arrive), places one real order with a live payment, ships it, returns it and
     refunds it (invoice and credit note arrive). Nothing may stay reserved: cancel or finish every test order.

## T-1 day

- The notice on the old site gives the time of the switch.
- Prepare the old server's move to `old.yalli.in` (see step 7 of the cut-over): its certificate and a copy of
  `config.php` and `admin/config.php` with the new address, ready to put in place.

## Cut-over (T0), in this order

1. **Old store: maintenance mode** (System → Settings → Server → Maintenance Mode). No new orders from here on. Note the
   last order number.
2. **Final catalogue and stock:** export again and convert (`migration/` gets a fresh `catalog.json`, `redirects.json`
   and `stock.csv`).
   - Products changed in OpenCart since T-14: `npm run import:catalog -- --file migration/catalog.json --update-existing`
     (dry run), then with `--apply --as <email> --publish`. If `redirects.json` changed, copy it, commit and
     `./scripts/deploy.sh production --skip-check`.
   - Stock: `npm run set:stock -- --file migration/stock.csv` shows what changes; then
     `npm run set:stock -- --file migration/stock.csv --apply --as <email>` sets each SKU's stock in the default
     warehouse to OpenCart's number (through the stock ledger, audited, never below what is reserved).
3. **Production settings to the main domain:** `FRONTEND_BASE_URL=https://yalli.in` (restart the API and worker
   services: force a new deployment), the new store's Razorpay webhook to `https://yalli.in/api/v1/webhooks/razorpay`.
   Keep the rehearsal hostname in CORS, Turnstile and the certificate until the rollback cut-off has passed.
4. **DNS:** point the main and the other hostname at CloudFront. With the 300-second TTL most visitors arrive within
   minutes.
5. **Check** (and from now on set `SITE_URL=https://yalli.in` in `deploy/production.env`, so every deploy checks the
   site):
   - `npm run verify:site -- --url https://yalli.in --production`
   - `npm run verify:redirects -- --site https://yalli.in --urls migration/old-urls.txt`
   - `npm run verify:redirects -- --site https://www.yalli.in --main https://yalli.in --urls migration/old-urls.txt` (the
     other hostname keeps path and query; swap the names if www is the main one)
   - a test sign-up (email and SMS arrive) and a live payment (refund it).
   `verify:redirects` is gentle by default (2 at a time, 250 ms apart); do not raise it on the live site.
6. **Search engines:** Search Console → Sitemaps → submit `https://yalli.in/sitemap.xml` (remove an old sitemap address if
   one was submitted); the same in Bing Webmaster Tools.
7. **Old store** to `old.yalli.in`, not public: put the prepared `config.php` and `admin/config.php` in place
   (`HTTP_SERVER`/`HTTPS_SERVER` with the new address, or its links and admin login lead to the new site), its own valid
   certificate (HSTS demands HTTPS on every subdomain), an IP allow-list or a password in front. If the old store's
   Razorpay webhook or callback points at the main domain, change it in Razorpay to `old.yalli.in`, or its open orders'
   payment updates get lost. Old order links (`account/order/info`) reach the new site's order list, where those orders
   do not exist: customers asking about an old order go to support (the notice on sign-in says so).

## First 72 hours

- Alarms (`docs/ops/deployment-aws.md`): 5xx, p99, task counts, RDS, outbox backlog, DLQ, Redis, "PAYMENT AMOUNT
  MISMATCH", a rise in "CSP violation".
- Payments: Razorpay dashboard against orders marked PAID, every few hours on day one.
- 404s: CloudFront logs and Search Console "Pages" (Not found): an old address that matters gets an entry in
  `legacy-redirects-extra.json` and a deploy.
- The support inbox and contact-form messages (Admin → Messages): customers looking for their old account.

## Rolling back

- A bad release: `./scripts/deploy.sh production --rollback <previous commit>`.
- Back to OpenCart (only before the cut-off), in this order:
  1. the old server's `config.php` back to the main domain, out of maintenance mode;
  2. DNS back to the old server;
  3. the new store's Razorpay webhook and `FRONTEND_BASE_URL` back to `new.yalli.in` (its console stays reachable there);
  4. orders already placed on the new store are fulfilled from its console (the money is in Razorpay): take their
     quantities off OpenCart's stock by hand and tell those customers.

## After two weeks

- DNS TTL back to 3600 seconds.
- Remove the rehearsal hostname from the certificate, `CORS_ALLOWED_ORIGINS`, Turnstile, Razorpay and the WAF rule.
- Keep watching Search Console "Pages" weekly for a month.
- After about three months, build without `NEXT_PUBLIC_OLD_STORE_NOTICE`.
- OpenCart data: as decided above.
