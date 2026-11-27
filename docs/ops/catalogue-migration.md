# Moving the OpenCart catalogue to the new shop (Phase 12)

For the shop owner and whoever runs the commands. Do this on **staging** first (never on a developer database), check the
result in the console, and only then repeat it on production. Nothing here talks to the OpenCart server: you export once,
and everything else works on files.

## 1. Export from OpenCart (phpMyAdmin)

In phpMyAdmin, open the OpenCart database, choose **Export → Custom**, format **JSON**, and select these tables (the
prefix may differ from `oc_`):

`oc_product`, `oc_product_description`, `oc_product_to_category`, `oc_product_special`, `oc_product_image`,
`oc_product_attribute`, `oc_attribute_description`, `oc_product_option`, `oc_category`, `oc_category_description`,
`oc_manufacturer`, `oc_seo_url`.

Save the file (for example `opencart-export.json`). It contains no customer data if you select only these tables: do
not export customer, order or address tables.

Copy OpenCart's image folder too (the folder that contains `catalog/`, usually `image/` in the OpenCart directory).

## 2. Convert

```
npm run build
npm run convert:opencart -- --in opencart-export.json --out migration/
```

Options: `--language-id` (default 1, English), `--customer-group-id` (default 1, for sale prices), `--store-id`
(default 0), `--prefix` (default `oc_`). The command writes, into `migration/`:

| File | What it is |
|---|---|
| `catalog.json` | the import file (categories, products, one variant per product) |
| `tax-review.csv` | one row per SKU: fill in `gst_rate_percent` (0, 0.25, 3, 5, 12, 18, 28 or 40) and `hsn_code` |
| `images.json` | the image paths of each product (main image first) |
| `redirects.json` | each old product/category id and SEO keyword, and its new address (for the go-live redirects, Phase 15) |
| `warnings.txt` | everything adjusted or left out: read it all |

What the conversion does and does not do:
- Prices and sale prices become exact paise (no rounding through floating point). A sale price is taken only for the
  chosen customer group, while it is running today, and only when it is below the price.
- Disabled categories are left out; a product without an active category goes into "More products".
- Products with price 0 or no name are left out. Negative stock counts as 0.
- **OpenCart options (size, colour…) are not imported**: each such product is listed in `warnings.txt`; add its
  variants in the console after the import.
- Weights are not imported (OpenCart's weight unit varies per product). Enter them in the console if you use them.
- Product addresses use the OpenCart SEO keyword where there is one, so links stay recognisable.

## 3. GST rate and HSN code (with the accountant)

Give `tax-review.csv` to the accountant. When it is filled in, run the conversion again with it:

```
npm run convert:opencart -- --in opencart-export.json --out migration/ --tax migration/tax-review.csv
```

The command refuses a rate that is not a GST slab or an HSN code that is not 4 to 8 digits. A SKU left blank is
imported at 18%: the summary says how many are still blank.

## 4. Import (dry run first)

```
npm run import:catalog -- --file migration/catalog.json
npm run import:catalog -- --file migration/catalog.json --apply --as <staff-email>
```

(Or use **Admin → Import** for files up to 2 MB / 500 products.) Everything arrives as a **draft**; opening stock is
recorded through the stock ledger. Re-running is safe: existing products are left alone.

## 5. Images

```
npm run import:images -- --manifest migration/images.json --dir /path/to/opencart/image
npm run import:images -- --manifest migration/images.json --dir /path/to/opencart/image --apply --as <staff-email>
```

The staff member needs products.update. Files are read only from that folder (paths with `..`, absolute paths and links
pointing outside it are refused), checked like a console upload (JPEG, PNG or WebP, up to 5 MB), and stored under new
names. A product that already has images is skipped, so the command can be re-run. On production, images go to S3
(Phase 13); on staging they use the configured storage.

## 6. Review, then publish

In **Admin → Products**, check each draft against the live OpenCart page: name, price, sale price, stock, category,
images, GST rate and HSN code. Publish when it is right. Then set up shipping methods (Admin → Shipping) and launch
coupons, if any (Admin → Coupons).

## 7. Business details and the launch check

Fill in the storefront's `NEXT_PUBLIC_BUSINESS_*` values (see `frontend/.env.example`) and the backend's
`SELLER_LEGAL_NAME`, `SELLER_STATE`, `SELLER_GSTIN`, `FRONTEND_BASE_URL`, `SUPPORT_INBOX_EMAIL`. Then:

```
npm run check:launch -- --frontend-env frontend/.env.production --backend-env .env.production
```

It lists every missing or inconsistent value: a GSTIN with a typo (check character) or from another state than
`SELLER_STATE`, different GSTINs or legal names on the pages and on invoices, a website address that is not https, email
links that would point at localhost. It prints problems, never the values. The backend also refuses to start with an
invalid `SELLER_GSTIN`.

Record the accountant's and the lawyer's sign-offs in `docs/policies/store-policies-and-tax.md` (section 5).
