# Moving the OpenCart catalogue to the new shop (Phase 12)

For the shop owner and whoever runs the commands. Do this on **staging** first (never on a developer database), check the
result in the console, and only then repeat it on production. Nothing here talks to the OpenCart server: you export once,
and everything else works on files.

The converter reads OpenCart **3.x or 4.0.x** (SEO addresses in `oc_seo_url`; OpenCart 2 used `oc_url_alias` and is
not supported). Check the store's version under System → Maintenance before you start, and use phpMyAdmin 4.7 or newer
(older versions write JSON the converter cannot read). OpenCart 4.1 may keep special prices in another table: if your
specials do not come through, tell the developer.

## 1. Export from OpenCart (phpMyAdmin)

In phpMyAdmin, open the OpenCart database, choose **Export → Custom**, format **JSON**, and select these tables (the
prefix may differ from `oc_`):

`oc_product`, `oc_product_description`, `oc_product_to_category`, `oc_product_special`, `oc_product_image`,
`oc_product_attribute`, `oc_attribute_description`, `oc_product_option`, `oc_category`, `oc_category_description`,
`oc_manufacturer`, `oc_seo_url`, and, for a multi-store installation, `oc_product_to_store` and
`oc_category_to_store` (then only the store chosen with `--store-id` is converted).

Save the file (for example `opencart-export.json`). It contains no customer data if you select only these tables: do
not export customer, order or address tables.

Copy OpenCart's image folder too (the folder that contains `catalog/`, usually `image/` in the OpenCart directory).

## 2. Convert

```
npm run build
npm run convert:opencart -- --in opencart-export.json --out migration/
```

Options: `--language-id` (default 1, English), `--customer-group-id` (default 1, for sale prices), `--store-id`
(default 0), `--prefix` (default `oc_`), `--prices-include-gst` (see below). The command writes, into `migration/`:

| File | What it is |
|---|---|
| `catalog.json` | the import file (categories, products, one variant per product) |
| `tax-review.csv` | one row per SKU: fill in `gst_rate_percent` (0, 0.25, 3, 5, 12, 18, 28 or 40) and `hsn_code` |
| `images.json` | the image paths of each product (main image first) |
| `redirects.json` | each old product/category id and SEO keyword, and its new address (for the go-live redirects, Phase 15) |
| `warnings.txt` | everything adjusted or left out: read it all |

What the conversion does and does not do:
- **GST in prices.** This shop's prices include GST. OpenCart stores the price of a product WITH a tax class without
  tax (and adds the tax when it shows the price). Every product with a tax class therefore stops the conversion (no
  `catalog.json` is written) until you either fix those prices or confirm they already include GST by adding
  `--prices-include-gst`. Check one product on the live site first: is the price shown equal to the price in the admin?
- Prices and sale prices become exact paise (no rounding through floating point). A sale price is taken for the chosen
  customer group when it is below the price, with its dates: it starts at the start of its start date and ends at the
  start of its end date (as in OpenCart). A sale that has already ended is left out; one that has not started yet is
  imported with its start date.
- Disabled categories are left out; a product without an active category goes into "More products".
- Products with price 0, a price above ₹1 crore or no name are left out. Negative stock counts as 0. A duplicate SKU
  gets a suffix (`-OC<id>`).
- **OpenCart options (size, colour…) are not imported**: each such product is listed in `warnings.txt`; add its
  variants in the console after the import.
- Weights are not imported (OpenCart's weight unit varies per product). Enter them in the console if you use them.
- Product addresses use the OpenCart SEO keyword where there is one, so links stay recognisable.

## 3. GST rate and HSN code (with the accountant)

Give `tax-review.csv` to the accountant. When it is filled in, run the conversion again with it:

```
npm run convert:opencart -- --in opencart-export.json --out migration/ --tax migration/tax-review.csv
```

The command refuses a rate that is not a GST slab, an HSN code that is not 4 to 8 digits, and an HSN code without a
rate (the sheet is written again, so it would be lost). A SKU left blank is imported at 18%: the summary says how many
are still blank.

## 4. Import (dry run first)

```
npm run import:catalog -- --file migration/catalog.json
npm run import:catalog -- --file migration/catalog.json --apply --as <staff-email>
```

The staff member named by `--as` needs products.create and pricing.update, plus inventory.adjust when the file sets
opening stock, products.update with `--update-existing`, and products.publish with `--publish`. (Or use **Admin →
Import** for files up to 2 MB / 500 products.) Everything arrives as a **draft**, even products that are enabled in
OpenCart, unless you add `--publish`; opening stock is recorded through the stock ledger. Re-running is safe: existing
products are left alone.

## 5. Images

```
npm run import:images -- --manifest migration/images.json --dir /path/to/opencart/image
npm run import:images -- --manifest migration/images.json --dir /path/to/opencart/image --apply --as <staff-email>
```

The staff member needs products.update. Files are read only from that folder (paths with `..`, absolute paths and links
pointing outside it are refused, also when a file is swapped for a link during the run). The dry run already checks
each file's content (JPEG, PNG or WebP, up to 5 MB), as the upload does; files are stored under new names.

Re-running: a product that already has all its images is skipped. A product that was only partly uploaded (a bad file,
an interrupted run) is reported, not uploaded again (that would duplicate its first images): add the rest in the
console. A product whose address matches but whose SKU does not (made by hand before the migration) is never touched.

Images are stored in the configured storage (`STORAGE_DRIVER=s3` on staging and production, see
docs/ops/deployment-aws.md). Every file is re-encoded on upload (metadata removed, at most 2400 px, 25 megapixels at
most in the original), so the dry run's check and the upload agree.

## 6. Review, then publish

In **Admin → Products**, check each draft against the live OpenCart page: name, price, sale price, stock, category,
images, GST rate and HSN code. Publish when it is right. Then set up shipping methods (Admin → Shipping) and launch
coupons, if any (Admin → Coupons).

## 7. Business details and the launch check

Fill in the storefront's `NEXT_PUBLIC_BUSINESS_*` values, `NEXT_PUBLIC_TURNSTILE_SITE_KEY` and `FRONTEND_SERVER_KEY`
(see `frontend/.env.example`), and the backend's `SELLER_LEGAL_NAME`, `SELLER_STATE`, `SELLER_GSTIN`,
`FRONTEND_BASE_URL`, `SUPPORT_INBOX_EMAIL` and the same `FRONTEND_SERVER_KEY`. For the home page banner, create
`frontend/public/banners/`, put the image there and set `NEXT_PUBLIC_HOME_HERO_IMAGE=/banners/<file>` and
`NEXT_PUBLIC_HOME_HERO_ALT`. Then:

```
npm run check:launch -- --frontend-env frontend/.env.production --backend-env .env.production
```

It lists every missing or inconsistent value: a GSTIN with a typo (check character) or from another state than
`SELLER_STATE`, different GSTINs or legal names on the pages and on invoices, a website address that is not https, email
links that would point at localhost, a different `FRONTEND_SERVER_KEY` in the two apps (a key set only in the hosting
environment is a warning: compare it there). It names the settings, never their values. The backend also refuses to start with an
invalid `SELLER_GSTIN`.

Record the accountant's and the lawyer's sign-offs in `docs/policies/store-policies-and-tax.md` (section 5).
