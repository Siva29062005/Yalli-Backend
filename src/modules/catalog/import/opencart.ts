import { slugify } from '../../../common/utils/slug.js';
import { GST_SLABS_BPS, IMPORT_LIMITS, decodeEntities } from './import-file.js';

/**
 * OpenCart (3.x / 4.0.x) -> the catalogue import file (pure, unit-tested; it never touches a database or the network).
 *
 * Input: a phpMyAdmin "Export -> JSON" of the store's tables (an array of `{ type: 'table', name, data: [...] }`, every
 * value a string or null). Output: the import file, plus what the migration needs around it:
 *  - `images`: per product slug, the OpenCart image paths (relative to OpenCart's `image/` folder) to upload later;
 *  - `redirects`: old OpenCart URLs (ids and SEO keywords) -> new paths, for the go-live 301s;
 *  - `taxSheet`: one row per SKU for the accountant to fill in GST rate and HSN code;
 *  - `warnings`: everything that was adjusted or left out, so nothing changes silently.
 * Money: OpenCart DECIMAL strings ("499.5000") are turned into integer paise with string maths (never a float).
 */

export type Row = Record<string, string | null>;
export type Tables = Record<string, Row[]>;

/** Reads a phpMyAdmin JSON export into tables keyed WITHOUT the prefix (`oc_product` -> `product`). */
export function readPhpMyAdminJson(raw: unknown, prefix = 'oc_'): Tables {
  if (!Array.isArray(raw))
    throw new Error('Not a phpMyAdmin JSON export (expected an array)');
  const tables: Tables = {};
  for (const item of raw) {
    const o = item as { type?: unknown; name?: unknown; data?: unknown };
    if (
      o?.type !== 'table' ||
      typeof o.name !== 'string' ||
      !Array.isArray(o.data)
    )
      continue;
    const name = o.name.startsWith(prefix)
      ? o.name.slice(prefix.length)
      : o.name;
    tables[name] = o.data
      .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
      .map((r) => {
        const row: Row = {};
        for (const [k, v] of Object.entries(r as Record<string, unknown>))
          row[k] = v === null || v === undefined ? null : String(v);
        return row;
      });
  }
  for (const required of [
    'product',
    'product_description',
    'category',
    'category_description',
    'product_to_category',
  ])
    if (!tables[required])
      throw new Error(`The export has no "${prefix}${required}" table`);
  return tables;
}

/** "499.5000" -> 49950 (half-up on the third decimal); null for anything that is not a plain non-negative amount. */
export function decimalToPaise(
  value: string | null | undefined,
): number | null {
  const m = /^(\d{1,12})(?:\.(\d{1,8}))?$/.exec((value ?? '').trim());
  if (!m) return null;
  const frac = (m[2] ?? '').padEnd(3, '0');
  const paise =
    Number(m[1]) * 100 +
    Number(frac.slice(0, 2)) +
    (Number(frac[2]) >= 5 ? 1 : 0);
  return Number.isSafeInteger(paise) ? paise : null;
}

export interface TaxEntry {
  gstRateBps: number;
  hsnCode?: string | undefined;
}

export interface ConvertOptions {
  languageId?: string;
  customerGroupId?: string;
  storeId?: string;
  /** "today" for the sale-price dates (India calendar day, yyyy-mm-dd). */
  today: string;
  /** GST rate and HSN per SKU (from the filled-in tax sheet). */
  tax?: ReadonlyMap<string, TaxEntry>;
  /**
   * OpenCart stores a price WITHOUT tax when the product has a tax class (and adds tax when showing it); this shop's
   * prices include GST. Unless the owner confirms the OpenCart prices already include GST, such products block the
   * conversion (they would go live without their GST).
   */
  pricesIncludeGst?: boolean;
}

export interface RedirectEntry {
  kind: 'product' | 'category' | 'brand';
  /** OpenCart id (product_id, manufacturer_id, or the category path such as "20_27"). */
  id: string;
  /** OpenCart SEO keyword, when one exists. */
  keyword: string | null;
  to: string;
}

export interface ConvertResult {
  file: {
    version: 1;
    options: { decodeEntityEncodedDescriptions: true };
    categories: {
      key: string;
      name: string;
      slug: string;
      parentKey: string | null;
    }[];
    products: Record<string, unknown>[];
  };
  images: {
    productSlug: string;
    /** The product's SKUs: import:images refuses a product with this slug that has none of them (a different product). */
    skus: string[];
    images: { path: string; altText?: string }[];
  }[];
  redirects: RedirectEntry[];
  taxSheet: string[][];
  warnings: string[];
  /** Problems that make the result unusable as it is: the CLI writes no catalog.json while there are any. */
  blocking: string[];
}

export const TAX_SHEET_COLUMNS = [
  'sku',
  'product',
  'gst_rate_percent',
  'hsn_code',
] as const;

const FALLBACK_CATEGORY = {
  key: 'oc-uncategorised',
  name: 'More products',
  slug: 'more-products',
};
const SKU_OK = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** The import file's largest amount (₹1 crore). */
const MAX_PAISE = 1_000_000_000;
const ZERO_DATE = /^0000-00-00/;

const text = (v: string | null | undefined, max: number) =>
  decodeEntities(v ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();

/** Unique slugs: the first keeps its slug, later ones get -2, -3, … */
function uniquer(): (base: string) => string {
  const seen = new Set<string>();
  return (base) => {
    // room for a -NN suffix within every slug limit; never end on a hyphen after cutting
    const root = (base || 'item').slice(0, 110).replace(/-+$/, '') || 'item';
    let slug = root;
    for (let n = 2; seen.has(slug); n++) slug = `${root}-${n}`;
    seen.add(slug);
    return slug;
  };
}

/** SEO keywords per (key, value): OpenCart 4 (`key`/`value` columns) and 3 (`query` = "product_id=42"). */
function seoKeywords(tables: Tables, languageId: string, storeId: string) {
  const map = new Map<string, string>();
  /** category id -> its full OpenCart path ("20_27"), as in old category URLs */
  const paths = new Map<string, string>();
  for (const r of tables['seo_url'] ?? []) {
    if (
      (r['language_id'] ?? languageId) !== languageId ||
      (r['store_id'] ?? storeId) !== storeId
    )
      continue;
    const keyword = (r['keyword'] ?? '').trim();
    if (!keyword) continue;
    if (r['key'] !== undefined && r['key'] !== null) {
      map.set(`${r['key']}=${r['value']}`, keyword);
      // OpenCart 4.0.2+: a subcategory is key "path", value "20_27": index it by its own id too
      if (r['key'] === 'path' && r['value']?.includes('_'))
        map.set(`path=${r['value'].split('_').pop()}`, keyword);
      if (r['key'] === 'path')
        paths.set(r['value']?.split('_').pop() ?? '', r['value'] ?? '');
    } else if (r['query']) {
      map.set(r['query'], keyword);
      const m = /^path=([\d_]+)$/.exec(r['query']);
      if (m) {
        map.set(`path=${m[1]!.split('_').pop()}`, keyword);
        paths.set(m[1]!.split('_').pop() ?? '', m[1]!);
      }
    }
  }
  return { map, paths };
}

export function convertOpenCart(
  tables: Tables,
  opts: ConvertOptions,
): ConvertResult {
  const lang = opts.languageId ?? '1';
  const group = opts.customerGroupId ?? '1';
  const store = opts.storeId ?? '0';
  const warnings: string[] = [];
  const { map: seo, paths: catPaths } = seoKeywords(tables, lang, store);
  const blocking: string[] = [];
  // multi-store exports: only this store's products and categories (when the link tables were exported)
  const inStore = (table: string, idCol: string) =>
    tables[table]
      ? new Set(
          tables[table]!.filter((r) => (r['store_id'] ?? store) === store).map(
            (r) => r[idCol] ?? '',
          ),
        )
      : null;
  const productsInStore = inStore('product_to_store', 'product_id');
  const categoriesInStore = inStore('category_to_store', 'category_id');
  const byLang = (rows: Row[] | undefined, idCol: string) =>
    new Map(
      (rows ?? [])
        .filter((r) => (r['language_id'] ?? lang) === lang)
        .map((r) => [r[idCol] ?? '', r]),
    );

  // ------------------------------------------------------------------ categories (parents before children)
  const catDesc = byLang(tables['category_description'], 'category_id');
  const catRows = tables['category'] ?? [];
  const active = new Map(
    catRows
      .filter((c) => c['status'] !== '0')
      .filter(
        (c) =>
          !categoriesInStore || categoriesInStore.has(c['category_id'] ?? ''),
      )
      .map((c) => [c['category_id'] ?? '', c]),
  );
  for (const c of catRows)
    if (c['status'] === '0')
      warnings.push(
        `Category ${c['category_id']} is disabled in OpenCart: not imported`,
      );
  const catSlug = uniquer();
  const categories: ConvertResult['file']['categories'] = [];
  const catKey = (id: string) => `oc-c${id}`;
  const placed = new Set<string>();
  const place = (id: string, depth = 0): void => {
    if (placed.has(id) || !active.has(id)) return;
    if (depth > 20) {
      warnings.push(
        `Category ${id} is part of a parent loop: imported at the top level`,
      );
      active.get(id)!['parent_id'] = '0';
    }
    const c = active.get(id)!;
    let parent =
      c['parent_id'] && c['parent_id'] !== '0' ? c['parent_id'] : null;
    if (parent && !active.has(parent)) {
      warnings.push(
        `Category ${id}: its parent ${parent} is missing or disabled, so it is imported at the top level`,
      );
      parent = null;
    }
    if (parent) place(parent, depth + 1);
    if (placed.has(id)) return;
    const name = text(catDesc.get(id)?.['name'], 120) || `Category ${id}`;
    const keyword =
      seo.get(`category_id=${id}`) ?? seo.get(`path=${id}`) ?? null;
    categories.push({
      key: catKey(id),
      name,
      slug: catSlug(slugify(keyword?.split('/').pop() ?? name)),
      parentKey: parent ? catKey(parent) : null,
    });
    placed.add(id);
  };
  for (const id of active.keys()) place(id);

  // ------------------------------------------------------------------ products
  const desc = byLang(tables['product_description'], 'product_id');
  const brands = new Map(
    (tables['manufacturer'] ?? []).map((m) => [
      m['manufacturer_id'] ?? '',
      text(m['name'], 80),
    ]),
  );
  const usedBrands = new Set<string>(); // manufacturers with at least one converted product (they get a brand page)
  const toCats = new Map<string, string[]>();
  for (const r of tables['product_to_category'] ?? []) {
    const list = toCats.get(r['product_id'] ?? '') ?? [];
    if (active.has(r['category_id'] ?? ''))
      list.push(catKey(r['category_id']!));
    toCats.set(r['product_id'] ?? '', list);
  }
  const specials = new Map<string, Row[]>();
  for (const s of tables['product_special'] ?? []) {
    if ((s['customer_group_id'] ?? group) !== group) continue;
    const end = s['date_end'] ?? '';
    // OpenCart: a special runs while date_end > NOW(), i.e. it is over from the start of its end date
    if (end && !ZERO_DATE.test(end) && end.slice(0, 10) <= opts.today) continue;
    specials.set(s['product_id'] ?? '', [
      ...(specials.get(s['product_id'] ?? '') ?? []),
      s,
    ]);
  }
  const attrNames = byLang(tables['attribute_description'], 'attribute_id');
  const attrs = new Map<string, { name: string; value: string }[]>();
  for (const a of tables['product_attribute'] ?? []) {
    if ((a['language_id'] ?? lang) !== lang) continue;
    const name = text(attrNames.get(a['attribute_id'] ?? '')?.['name'], 80);
    const value = text(a['text'], 300);
    if (!name || !value) continue;
    attrs.set(a['product_id'] ?? '', [
      ...(attrs.get(a['product_id'] ?? '') ?? []),
      { name, value },
    ]);
  }
  const extraImages = new Map<string, Row[]>();
  for (const i of tables['product_image'] ?? [])
    extraImages.set(i['product_id'] ?? '', [
      ...(extraImages.get(i['product_id'] ?? '') ?? []),
      i,
    ]);
  const withOptions = new Set(
    (tables['product_option'] ?? []).map((o) => o['product_id'] ?? ''),
  );

  const prodSlug = uniquer();
  const skus = new Set<string>();
  const products: Record<string, unknown>[] = [];
  const images: ConvertResult['images'] = [];
  const redirects: RedirectEntry[] = [];
  const taxSheet: string[][] = [];
  let needsFallback = false;

  for (const p of tables['product'] ?? []) {
    const id = p['product_id'] ?? '';
    const label = `Product ${id}`;
    const d = desc.get(id);
    const name = text(d?.['name'], 200);
    if (!name) {
      warnings.push(`${label}: no name in language ${lang}, not imported`);
      continue;
    }
    if (productsInStore && !productsInStore.has(id)) continue;
    const priceMinor = decimalToPaise(p['price']);
    if (priceMinor !== null && priceMinor > MAX_PAISE) {
      warnings.push(
        `${label} "${name}": price ${p['price']} is above ₹1 crore, not imported`,
      );
      continue;
    }
    if (
      p['tax_class_id'] &&
      p['tax_class_id'] !== '0' &&
      !opts.pricesIncludeGst
    )
      blocking.push(
        `${label} "${name}": has an OpenCart tax class, so its price ${p['price']} is probably WITHOUT tax (this shop's prices include GST). Fix the prices, or confirm they already include GST (--prices-include-gst)`,
      );
    if (priceMinor === null || priceMinor < 1) {
      warnings.push(
        `${label} "${name}": no valid price (${p['price'] ?? 'empty'}), not imported`,
      );
      continue;
    }
    let sku = (p['sku'] || p['model'] || '')
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^[^A-Za-z0-9]+/, '')
      .slice(0, 64);
    if (!SKU_OK.test(sku)) sku = `OC-${id}`;
    if (skus.has(sku.toUpperCase())) {
      const suffix = `-OC${id}`.slice(0, 30);
      let unique = `${sku.slice(0, 64 - suffix.length)}${suffix}`;
      for (let n = 2; skus.has(unique.toUpperCase()); n++)
        unique = `${sku.slice(0, 64 - suffix.length - String(n).length - 1)}${suffix}-${n}`;
      warnings.push(
        `${label} "${name}": SKU ${sku} is used twice; this one becomes ${unique}`,
      );
      sku = unique;
    }
    skus.add(sku.toUpperCase());

    // the special running today (OpenCart's choice: priority, then price); else the next one to start
    const running = (s: Row) =>
      !s['date_start'] ||
      ZERO_DATE.test(s['date_start']) ||
      s['date_start'].slice(0, 10) <= opts.today;
    const byPriority = (a: Row, b: Row) =>
      Number(a['priority'] ?? 0) - Number(b['priority'] ?? 0) ||
      (decimalToPaise(a['price']) ?? 0) - (decimalToPaise(b['price']) ?? 0);
    const all = specials.get(id) ?? [];
    const sale =
      [...all.filter(running)].sort(byPriority)[0] ??
      [...all].sort((a, b) =>
        (a['date_start'] ?? '').localeCompare(b['date_start'] ?? ''),
      )[0];
    const saleDates = sale ? openCartSaleWindow(sale) : {};
    let salePriceMinor = sale ? decimalToPaise(sale['price']) : null;
    if (sale && salePriceMinor === null)
      warnings.push(
        `${label} "${name}": special price ${sale['price']} is not a valid amount, ignored`,
      );
    if (
      salePriceMinor !== null &&
      (salePriceMinor < 1 || salePriceMinor >= priceMinor)
    ) {
      warnings.push(
        `${label} "${name}": special price ${sale!['price']} is not below the price, ignored`,
      );
      salePriceMinor = null;
    }
    const quantity = Number.parseInt(p['quantity'] ?? '0', 10);
    if (!Number.isFinite(quantity) || quantity < 0)
      warnings.push(`${label} "${name}": stock ${p['quantity']} counted as 0`);
    let categoryKeys = [...new Set(toCats.get(id) ?? [])].slice(0, 10);
    if (categoryKeys.length === 0) {
      warnings.push(
        `${label} "${name}": no active category, placed in "${FALLBACK_CATEGORY.name}"`,
      );
      categoryKeys = [FALLBACK_CATEGORY.key];
      needsFallback = true;
    }
    if (withOptions.has(id))
      warnings.push(
        `${label} "${name}": has OpenCart options (size, colour…) that are NOT imported: add them as variants in the console`,
      );

    const keyword = seo.get(`product_id=${id}`) ?? null;
    const slug = prodSlug(slugify(keyword ?? name));
    const tags = [
      ...new Set(
        (d?.['tag'] ?? '')
          .split(',')
          .map((t) => text(t, 40))
          .filter(Boolean),
      ),
    ].slice(0, 20);
    const summary = text(d?.['meta_description'], 500);
    const tax = opts.tax?.get(sku.toUpperCase());
    const product: Record<string, unknown> = {
      key: `oc-p${id}`,
      name,
      slug,
      ...(summary ? { summary } : {}),
      ...(d?.['description']
        ? { descriptionHtml: (d['description'] ?? '').slice(0, 50_000) }
        : {}),
      ...(p['manufacturer_id'] && brands.get(p['manufacturer_id'])
        ? (usedBrands.add(p['manufacturer_id']),
          { brand: brands.get(p['manufacturer_id']) })
        : {}),
      categoryKeys,
      ...(tags.length ? { tags } : {}),
      ...(attrs.get(id)?.length
        ? { attributes: attrs.get(id)!.slice(0, 50) }
        : {}),
      ...(tax
        ? {
            gstRateBps: tax.gstRateBps,
            ...(tax.hsnCode ? { hsnCode: tax.hsnCode } : {}),
          }
        : {}),
      status: p['status'] === '1' ? 'PUBLISHED' : 'DRAFT',
      variants: [
        {
          sku,
          priceMinor,
          ...(salePriceMinor !== null ? { salePriceMinor, ...saleDates } : {}),
          stock:
            Number.isFinite(quantity) && quantity > 0
              ? Math.min(quantity, 1_000_000)
              : 0,
        },
      ],
    };
    products.push(product);
    taxSheet.push([
      sku,
      name,
      tax ? String(tax.gstRateBps / 100) : '',
      tax?.hsnCode ?? '',
    ]);

    const paths = [
      ...(p['image'] ? [{ path: p['image'], order: -1 }] : []),
      ...(extraImages.get(id) ?? []).map((i) => ({
        path: i['image'] ?? '',
        order: Number(i['sort_order'] ?? 0),
      })),
    ]
      .filter((i) => i.path)
      .sort((a, b) => a.order - b.order)
      .map((i) => i.path);
    const unique = [...new Set(paths)].slice(0, 20);
    if (unique.length)
      images.push({
        productSlug: slug,
        skus: [sku],
        images: unique.map((path) => ({ path, altText: name.slice(0, 200) })),
      });
    redirects.push({ kind: 'product', id, keyword, to: `/products/${slug}` });
  }
  if (!tables['product']?.length) warnings.push('The export has no products');
  // brand pages: the importer names a brand's page after slugify(name)
  for (const id of usedBrands) {
    const name = brands.get(id)!;
    const slug = slugify(name);
    if (!slug) continue;
    redirects.push({
      kind: 'brand',
      id,
      keyword: seo.get(`manufacturer_id=${id}`) ?? null,
      to: `/brands/${slug}`,
    });
  }
  if (needsFallback)
    categories.push({
      key: FALLBACK_CATEGORY.key,
      name: FALLBACK_CATEGORY.name,
      slug: catSlug(FALLBACK_CATEGORY.slug),
      parentKey: null,
    });

  for (const c of categories) {
    if (c.key === FALLBACK_CATEGORY.key) continue;
    const id = c.key.slice('oc-c'.length);
    const keyword =
      seo.get(`category_id=${id}`) ?? seo.get(`path=${id}`) ?? null;
    redirects.push({
      kind: 'category',
      id: catPaths.get(id) ?? id, // "20_27" as in old category URLs, when known
      keyword,
      to: `/catalog/${c.slug}`,
    });
  }
  if (products.length > IMPORT_LIMITS.products)
    blocking.push(
      `${products.length} products: one import file takes at most ${IMPORT_LIMITS.products}`,
    );
  if (categories.length > IMPORT_LIMITS.categories)
    blocking.push(
      `${categories.length} categories: one import file takes at most ${IMPORT_LIMITS.categories}`,
    );

  return {
    file: {
      version: 1,
      options: { decodeEntityEncodedDescriptions: true },
      categories,
      products,
    },
    images,
    redirects,
    taxSheet,
    warnings,
    blocking,
  };
}

/** OpenCart special dates (DATE, India) -> the sale window: from the start of date_start to the start of date_end. */
function openCartSaleWindow(s: Row): {
  saleStartsAt?: string;
  saleEndsAt?: string;
} {
  const day = (v: string | null | undefined) =>
    v && !ZERO_DATE.test(v) && /^\d{4}-\d{2}-\d{2}/.test(v)
      ? `${v.slice(0, 10)}T00:00:00+05:30`
      : undefined;
  const start = day(s['date_start']);
  const end = day(s['date_end']);
  return {
    ...(start ? { saleStartsAt: start } : {}),
    ...(end ? { saleEndsAt: end } : {}),
  };
}

/** The filled-in tax sheet (CSV: sku, product, gst_rate_percent, hsn_code) -> tax per SKU, or the problems found. */
export function parseTaxSheet(csv: string): {
  tax: Map<string, TaxEntry>;
  problems: string[];
} {
  const rows = parseCsv(csv);
  const tax = new Map<string, TaxEntry>();
  const problems: string[] = [];
  const header = (rows.shift() ?? []).map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const [iSku, iRate, iHsn] = [
    col('sku'),
    col('gst_rate_percent'),
    col('hsn_code'),
  ];
  if (iSku < 0 || iRate < 0)
    return {
      tax,
      problems: ['The tax sheet needs the columns sku and gst_rate_percent'],
    };
  rows.forEach((r, n) => {
    const line = n + 2;
    const sku = (r[iSku] ?? '').trim().replace(/^'/, '');
    const rate = (r[iRate] ?? '').trim();
    const hsn = (iHsn >= 0 ? (r[iHsn] ?? '') : '').trim().replace(/^'/, '');
    if (!sku) return;
    if (!rate) {
      // an HSN code alone would be lost (the sheet is written again): ask for the rate too
      if (hsn)
        problems.push(
          `line ${line}: ${sku}: HSN code given without a GST rate`,
        );
      return; // not filled in yet: the importer's default applies
    }
    const m = /^(\d{1,2})(?:\.(\d{1,2}))?$/.exec(rate);
    const bps = m
      ? Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'))
      : NaN;
    if (!(GST_SLABS_BPS as readonly number[]).includes(bps)) {
      problems.push(
        `line ${line}: ${sku}: GST rate "${rate}" is not a GST slab (${GST_SLABS_BPS.map((b) => b / 100).join(', ')})`,
      );
      return;
    }
    if (hsn && !/^\d{4,8}$/.test(hsn)) {
      problems.push(
        `line ${line}: ${sku}: HSN code "${hsn}" must be 4 to 8 digits`,
      );
      return;
    }
    tax.set(sku.toUpperCase(), {
      gstRateBps: bps,
      ...(hsn ? { hsnCode: hsn } : {}),
    });
  });
  return { tax, problems };
}

/** Minimal RFC 4180 reader (quoted cells, doubled quotes, CRLF or LF). */
export function parseCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const text = csv.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c !== '')) rows.push(row);
  return rows;
}
