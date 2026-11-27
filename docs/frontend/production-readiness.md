# Frontend readiness and category management

## Implemented category workflow

- `/admin/categories` uses real staff password + authenticator login and the existing MFA step-up policy. Access tokens are memory-only; reload requires sign-in. No browser role or demo identity authorises API requests.
- Staff with `products.read` can list all categories, including hidden ones. Changes require `products.update`; deletion requires `products.delete`. The backend remains authoritative.
- Create/edit supports name, unique URL slug, parent, position (0–1000), and visibility. Smaller positions appear first. The UI excludes descendants from parent selection; the backend also rejects cycles.
- Deletion is permanent, requires typed confirmation, and is blocked for categories containing products or children. Hide those categories instead. Existing taxonomy audit records remain in place.
- Header, home tiles, catalogue filters, footer, and product category selectors read `/catalog/categories`; there is no hard-coded category fallback. Empty/error/loading states are explicit. Updates refresh the current tab; other tabs refresh on focus. The public endpoint permits browser caching for up to 60 seconds, though the client requests fresh data.
- Desktop navigation shows four quick links and a scrollable all-categories menu. Mobile navigation scrolls independently. New category routes do not require a rebuild.

## Local configuration

The browser only ever calls its own origin: Next rewrites `/api/v1/*` to `API_INTERNAL_URL` (default `http://127.0.0.1:3000/api/v1`), and server-rendered pages call the same address directly. The rewrite target is fixed at build time, so set `API_INTERNAL_URL` for `npm run build` as well as `next start`. Run the frontend on a different port from the backend, for example `npm run dev -- --port 3001` (the backend's `FRONTEND_BASE_URL` defaults to it). Because requests are same-origin, no backend CORS entry is needed for the storefront. Production must use HTTPS and secure cookies. A staff account with enrolled MFA is required; this screen does not bypass enrolment or permissions.

## Validation and styling

Tailwind's direct package and PostCSS compiler are aligned at 4.3.5. The previous mismatch left raw `@theme` / `@tailwind` directives in production CSS, so compilation alone did not guarantee that styles were applied. Browser regression checks exercise the built CSS, 40 categories (including a 100-character unbroken name), staff MFA, create/edit/delete, deletion confirmation, permission errors, and responsive menus. `frontend/scripts/test-categories.mjs` accepts `FRONTEND_URL`, `PLAYWRIGHT_MODULE`, and `CHROMIUM_PATH` for an installed browser runner. Unit category tests run with `npx vitest run frontend/src/lib/category-utils.spec.ts` from the repository root. Real-backend category coverage is in `test/commerce/categories.e2e-spec.ts`. `npm run check` runs the backend suite, the frontend unit specs, and the frontend lint (no warnings allowed), build and type-check; `npm run test:browser` runs every fake-backend browser script in one go.

## Staff workspace (wired 2026-11-19)

Every admin screen now talks to the real admin API through `admin-session` (password + authenticator code; access token in memory only). The shared pieces:

- `AdminAccess` gives each screen `withStepUp(call)`: when the API answers `STEP_UP_REQUIRED` it shows ONE authenticator prompt (even if several requests fail together) and retries the call. `useAdminQuery` applies this to loads.
- `lib/admin-api.ts` (`adminList`, `adminGet`, `adminPost`, `adminPatch`, `adminDelete`, rupee-to-paise parsing with no floating point) and `components/AdminKit.tsx` (page frame, alerts, pager, pills) keep the screens consistent.
- Screens: Overview (KPIs, revenue chart with table view, top products, GST), Products (list with category, price, stock; editor with variants and images), Categories, Reviews (moderation queue), Inventory (adjust + history), Orders (fulfilment, tracking, cancel), Refunds and returns (four-eyes), Coupons, Shipping methods, Users and roles.
- The browser sends only what the server then re-validates: prices in paise, a method code, role names; the server remains the authority on permissions, totals and stock. Hiding a button is never the access control.
- Backend additions made for these screens: `GET /admin/brands`, `GET /admin/users` (search, role and status filters; no credentials or phone numbers), and `order.orderNumber` on `GET /admin/refunds`.
- Regression: `frontend/scripts/test-admin-screens.mjs` (fake HTTP boundary, real pages) covers sign-in, the shared step-up retry, one action per screen with exact payloads, self-approval blocking and a 375px layout. `frontend/src/lib/analytics-utils.spec.ts` covers India-day ranges and chart axes. Run with `FRONTEND_URL`, `PLAYWRIGHT_MODULE` and `CHROMIUM_PATH` as described above.

## Not yet launch-ready

The storefront, customer account pages and staff screens call real APIs, but the whole shop is not certified for production. Open items are tracked in `docs/PENDING.md`; the main ones:

- The 2026-11-19 frontend review left launch blockers (captcha widget, an open redirect, cross-tab sign-out, double-counted MFA codes, home-page claims, server-side rate limiting); they are Phase 9 of `docs/ROADMAP.md`.
- Live Razorpay, SES, MSG91 and Turnstile have not been exercised; the policy pages still need the owner's business details and a lawyer's review.
- Accessibility audit (contrast, keyboard, screen reader), cross-browser mobile tests, performance and dependency audits, real deployment CORS/CSP/cookies/media, and API-failure monitoring are still to do.
- Do not treat frontend role visibility as an authorisation boundary.
