# Store policies, fees and tax decisions

Decisions adopted on 2026-11-19 so work does not wait on external answers. Each row says what the shop does today
(checked in the code), the rule it rests on, and where it is configured. The research came from public sources, mostly
secondary (tax-practitioner sites, Razorpay documentation); none of it is legal or tax advice. **Have your accountant
and a lawyer review this page, the public policy pages and the invoice format before you take real orders.**

## 1. What the shop does (verified in code)

| Topic | Behaviour | Configured in |
|---|---|---|
| Payment | Online only through Razorpay (no cash on delivery). Card and UPI details never reach our servers. Login is required to buy. | `payments` module |
| Payment window | An unpaid order holds its stock for `PAYMENT_WINDOW_MINUTES` (default 30), then it is cancelled and the stock released. At most `MAX_OPEN_UNPAID_ORDERS` (3) open unpaid orders per customer. | `src/config/env.ts` |
| Cancelling | Unpaid orders: customer can cancel any time. Paid orders: customer can cancel while the order is confirmed or being packed (not yet shipped); the full amount is refunded automatically to the original payment method. Shipped or later: use a return. Staff can also cancel (with a reason). | `order-state-machine.ts` |
| Returns | Only DELIVERED orders, within `RETURN_WINDOW_DAYS` (default **7**) of delivery. Reasons: arrived damaged/not working, faulty, ordered by mistake, wrong item, other (faulty/other need a description). One open return per order; cannot return more units than bought. Flow: request, staff approve/reject, goods received, refund requested, a second person approves. Unopened items go back on the shelf. | `return.service.ts`, `RETURN_WINDOW_DAYS` |
| Refund amount | The item's share of what the customer actually paid (after any coupon), rounded down. Delivery charges are not part of a return refund unless staff enter a custom amount (e.g. our error). Refunds go only to the original payment method. | `orders/return.service.ts` |
| Refund approval | Human-requested refunds need a second approver (four-eyes). | `src/modules/refunds/refund.service.ts` |
| Delivery fee | Decided only by the active shipping methods (Admin > Shipping). **With no active method delivery is free**, which is the current state. Fee, free-above value, delivery days and states served are per method. One shipment per order. | `shipping-rules.ts` |
| Prices and GST | Prices are GST-inclusive (default slab 18%, per product). A GST tax invoice is available per order (`GET /orders/:id/invoice`); CGST+SGST within the seller's state, IGST otherwise. | `pricing`, `orders/gst.ts` |
| Reviews | Verified purchasers only, plain text, moderated before they show. | `reviews` module |
| Account data | Deleting an account anonymises the profile; order records are kept for tax and warranty reasons. Staff accounts need MFA. | `customers`, `identity` |

## 2. Rules researched and how they are reflected

**Refund timing (Razorpay documentation).** After a refund is initiated, Razorpay lists: cards 5-10 working days,
netbanking 2-10, UPI 2-7, wallets 0-3. Public pages say "usually 5-10 working days, depending on your bank" and never
promise less. Instant refunds are not used.

**Consumer Protection (E-Commerce) Rules, 2020 (GSR 462(E)).** A grievance officer must be appointed and their name,
designation and contact shown on the site; complaints are acknowledged within 48 hours and resolved within one month.
Seller identity, and country of origin where known, should be disclosed. The /contact page shows these details from
`NEXT_PUBLIC_BUSINESS_*` settings (see section 4). **Owner action: name a grievance officer.**

**Digital Personal Data Protection Act 2023 and Rules 2025.** Rules notified 13 Nov 2025; the core notice, consent,
security, breach-reporting and erasure duties start on 13 May 2027 (some sources describe that date as computed, so
confirm it against Gazette G.S.R. 843(E)). The privacy policy is written to that standard already: what is collected and
why, retention, security, rights (access, correction, erasure), a contact for requests, children, and third-party
resources such as Google Fonts.

**Razorpay website review.** Sources disagree on whether policy pages are still mandatory at onboarding. Having the
privacy, terms, returns/refunds, shipping and contact pages linked from every footer is good practice either way, and the
registered website must match the checkout domain.

## 3. Tax decisions

**GST on delivery fees (decision, not yet implemented).** Under section 8 of the CGST Act a delivery charge billed with
the goods is part of one composite supply and takes the goods' rate; standalone delivery billed as its own service is
generally 18%. The rule adopted for this shop:
- Delivery charges stay **free** until the items below are built (the Admin > Shipping form warns when a fee is entered).
- When paid delivery is enabled: the fee is GST-inclusive like prices, apportioned across the order's lines in proportion
  to line value (`allocateProportionally` already exists in `cart-pricing.ts`), and taxed at each line's rate. That means:
  `priceCart` allocates shipping to lines, orders store the per-line share, the invoice shows delivery inside the lines
  (or as an apportioned line), and the analytics GST summary includes it.
- A mixed-rate cart is apportioned, not "highest rate", so the tax is never overstated.
- Confirm with your accountant before charging, because litigation on delivery charges is unsettled (a West Bengal
  appellate body recently refused to let an e-commerce operator split delivery out of a composite supply).
  Section 9(5) (e-commerce operator liability on local delivery) concerns marketplaces; this is a single-seller store.

**Credit notes (decision, not yet implemented).** Section 34 of the CGST Act: when goods are returned or a refund
reduces the taxable value, the seller issues a credit note referencing the original invoice. There is no time limit to
issue one, but to reduce your tax liability it must be reported in your return by **30 November following the end of the
financial year of the original supply** (or the annual-return date, if earlier). The Finance Act 2026 amended section 34
for post-sale discounts; verify the current text. Until built, finance issues credit notes manually from the refund list
(Admin > Refunds) in the accounting system, and the GST summary does not net refunds (it says so). Planned build: a credit
note document per PROCESSED refund (number series, original invoice reference, proportional CGST/SGST/IGST split, PDF for
the customer) and a GST summary that nets them.

## 4. Business details the public pages need (owner input)

The pages never invent these. Set them in `frontend/.env.local` (or the hosting environment) before launch; anything
missing is simply left out in production (and flagged in development):
`NEXT_PUBLIC_BUSINESS_LEGAL_NAME`, `..._REGISTERED_ADDRESS`, `..._GSTIN`, `..._SUPPORT_EMAIL`, `..._SUPPORT_PHONE`,
`..._SUPPORT_HOURS`, `..._GRIEVANCE_OFFICER_NAME`, `..._GRIEVANCE_OFFICER_DESIGNATION`, `..._GRIEVANCE_OFFICER_EMAIL`,
`..._GRIEVANCE_OFFICER_PHONE`, `..._WEBSITE_URL`. The backend needs `SELLER_STATE` and (in production) `SELLER_GSTIN`.

## 5. Sources

- GST on delivery: [Section 8 composite supplies](https://gstgyaan.com/section-8-gst-liability-on-composite-and-mixed-supplies), [GST treatment of shipping and packing fees](https://emerge.fibre2fashion.com/blogs/10925/shipping-cod-charges-packing-fees-gst-treatment-that-won-t-break-your-books), [West Bengal appellate body on Flipkart delivery](https://www.angelone.in/news/unlisted-companies/west-bengal-apellate-body-rejects-flipkart-s-gta-claim-18-gst-to-apply-on-delivery-charges)
- Credit notes: [Section 34 explained](https://taxguru.in/goods-and-service-tax/section-34-understanding-credit-notes-gst.html), [credit notes and refunds](https://taxguru.in/goods-and-service-tax/adjustment-tax-liability-refund-gst-credit-note.html)
- E-commerce rules: [Mondaq summary](https://www.mondaq.com/india/dodd-frank-consumer-protection-act/985606/the-consumer-protection-e-commerce-rules-2020), [LiveLaw analysis](https://www.livelaw.in/columns/consumer-protection-in-the-online-marketplace-an-analysis-of-consumer-protection-e-commerce-rules-2020-161516)
- DPDP: [phased rollout](https://www.azbpartners.com/bank/indias-digital-personal-data-protection-act-phased-rollout-and-key-compliance-milestones/), [rules text](https://dpdprules.org/rules)
- Razorpay: [refund timelines](https://razorpay.com/docs/payments/refunds/normal.md), [website details](https://razorpay.com/docs/payments/dashboard/account-settings/business-website-details/), [compliance blog](https://razorpay.com/blog/payment-gateway-compliance/)
