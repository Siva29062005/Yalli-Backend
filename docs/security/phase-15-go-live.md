# Phase 15: go-live redirects and cut-over (2026-11-28)

What was built for replacing the OpenCart store, the review of commit 1f2b631 and its fixes. Runbook:
`docs/ops/go-live.md`.

## Controls

| Concern | Control | Where | Verified by |
|---|---|---|---|
| Old links and search rankings | Old OpenCart addresses get a 301 to their new page from the proxy, before routing; unknown addresses go on to the normal (prerendered) 404 | `frontend/src/proxy.ts`, `frontend/src/lib/legacy-redirects.ts` | `legacy-redirects.spec.ts` (65 cases); `test-static-pages.mjs` (301 with a relative Location, 404s, pages and the API untouched) |
| Open redirect / loops through the data files | Destinations must be a product, category or brand page or one of the fixed pages (`isSafeTarget`); anything else is dropped; `npm run check` fails if a committed entry is dropped; the Location is relative (Next relativises same-host redirects), so the host behind CloudFront never leaks | same | spec: hosts, `//`, `\`, `..`, queries, `javascript:`, unknown paths, `/api`, `/admin` refused |
| A new page shadowed by an old keyword | The proxy never redirects a path whose first segment is one of the shop's (`RESERVED_SEGMENTS`), or a file | same | spec compares the list with `src/app`; browser test: `/help`, `/brands`, `/products/<missing>` (own 404), `/api/v1/…`, `/_next/…` |
| Crashes on hostile addresses | `STATIC_ROUTES` is a Map (`?route=constructor`/`__proto__` were redirects to junk); search terms are cut by characters (an emoji cut in half threw); malformed percent-encoding goes to the normal 404 (it was a 500 with the catch-all page) | same | spec; browser test (`/%ZZ`, `route=constructor` → 404) |
| Real-world OpenCart address shapes | `&amp;` repaired, the last duplicate parameter wins (as PHP), ids read as numbers (`042`), `index.php?_route_=keyword`, `/?route=…`, `account/order/info`, OpenCart 4 `|` methods and language paths, `.html` | same | spec |
| Brand pages that do not exist | Converter emits brand entries only for brands with an ENABLED product, slug as the importer makes it (`slugify(stripTags(name))`), none for names without Latin letters (warning) | `catalog/import/opencart.ts` | `opencart.spec.ts` |
| Non-Latin brand names merged into one | The importer never matches brands by the fallback slug and allocates unique slugs | `catalog-import.service.ts` | `catalog-import.e2e-spec.ts` |
| Hand-computing stock in the freeze window | `npm run set:stock`: sets on-hand per SKU from `stock.csv` (converter), row locked, through `adjustInTx` (ledger, never below reserved), audited, dry run first | `cli/set-stock.ts`, `InventoryService.setOnHandInTx`, `inventory/stock-sheet.ts` | `stock-sheet.spec.ts`, `inventory.e2e-spec.ts` |
| Verifying the switch | `npm run verify:redirects`: follows permanent redirects (≤5), a page already (200) passes, landing on the home page from anything but a home address fails (a lost query string), `--main` checks the other hostname, reads sitemap XML (`&amp;`) and Search Console CSV, fails on an empty list or a cut list, 2 at a time with 250 ms pauses, bodies released; only `--site`/`--main` are ever requested | `cli/verify-redirects.ts`, `common/legacy-url-list.ts` | `legacy-url-list.spec.ts`; run against a mock site (chains, 307, 404, a query-dropping other hostname) |
| Accounts not migrated | The sign-in/sign-up notice (`NEXT_PUBLIC_OLD_STORE_NOTICE=1`, go-live builds only) | `components/OldStoreNotice.tsx` | `test-auth.mjs` (shown with the flag, absent without) |

## Operational risks handled in the runbook

Catalogue published only behind a WAF rule that limits the rehearsal hostname and the CloudFront name to the owner's IP
addresses (no double selling, not discoverable through certificate logs); emailed links point at the rehearsal hostname
until T0 (they must not reach the old server); a separate Razorpay webhook for the new store; the other hostname's 301
keeps path and query (CloudFront Function given); DNS host able to point the bare domain at CloudFront, nameserver moves
3 days ahead with every record copied; certificate in us-east-1; every subdomain on HTTPS because of HSTS
`includeSubDomains`; the old store at `old.yalli.in` with its own address in `config.php`, certificate and webhook; the
final catalogue and stock taken after maintenance mode; the rollback order.

## Residual

- Nothing here has run against the live store, AWS or DNS: the rehearsal (T-14) is the test.
- `verify:redirects` checks the addresses in the list only; Search Console's "Not found" report finds the rest after T0.
- A brand created in the console before the import keeps its own slug: `verify:redirects` reports its old page, fixed
  with an entry in `legacy-redirects-extra.json`.
