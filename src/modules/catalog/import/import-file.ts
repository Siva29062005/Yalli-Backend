import { z } from 'zod';
import { SLUG_PATTERN, slugify } from '../../../common/utils/slug.js';

/**
 * The catalogue import file (JSON). It is deliberately source-neutral: an OpenCart export, a spreadsheet or any other
 * system is converted INTO this format, and this module validates it completely before anything is written.
 * Money is integer paise; there is no floating-point price anywhere in the format.
 */
export const GST_SLABS_BPS = [0, 25, 300, 500, 1200, 1800, 2800, 4000] as const;
export const IMPORT_LIMITS = {
  products: 5_000,
  categories: 1_000,
  brands: 500,
  maxFileBytes: 20 * 1024 * 1024,
} as const;

const text = (max: number) => z.string().trim().min(1).max(max);
const key = z.string().trim().min(1).max(64);
const slug = z.string().regex(SLUG_PATTERN).max(160);
const paise = z.number().int().min(1).max(1_000_000_000);
const gst = z.union(
  GST_SLABS_BPS.map((n) => z.literal(n)) as unknown as [
    z.ZodLiteral<number>,
    z.ZodLiteral<number>,
    ...z.ZodLiteral<number>[],
  ],
);

const variantSchema = z
  .object({
    sku: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, 'letters, digits, . _ -'),
    name: text(120).optional(),
    priceMinor: paise,
    salePriceMinor: paise.optional(),
    stock: z.number().int().min(0).max(1_000_000),
    weightGrams: z.number().int().min(0).max(1_000_000).optional(),
  })
  .strict()
  .refine(
    (v) => v.salePriceMinor === undefined || v.salePriceMinor < v.priceMinor,
    {
      message: 'salePriceMinor must be lower than priceMinor',
      path: ['salePriceMinor'],
    },
  );

const productSchema = z
  .object({
    key: key.optional(),
    name: text(200),
    slug: slug.optional(),
    summary: z.string().trim().max(500).optional(),
    descriptionHtml: z.string().max(50_000).optional(),
    brand: text(80).optional(),
    categoryKeys: z.array(key).min(1).max(10),
    tags: z.array(text(40)).max(20).optional(),
    attributes: z
      .array(z.object({ name: text(80), value: text(300) }).strict())
      .max(50)
      .optional(),
    gstRateBps: gst.optional(),
    hsnCode: z
      .string()
      .regex(/^\d{4,8}$/)
      .optional(),
    status: z.enum(['DRAFT', 'PUBLISHED']).default('DRAFT'),
    variants: z.array(variantSchema).min(1).max(50),
  })
  .strict();

export const importFileSchema = z
  .object({
    version: z.literal(1),
    options: z
      .object({
        /** OpenCart stores descriptions HTML-escaped (`&lt;p&gt;`): decode that one level before sanitising. */
        decodeEntityEncodedDescriptions: z.boolean().default(false),
      })
      .strict()
      .default({ decodeEntityEncodedDescriptions: false }),
    categories: z
      .array(
        z
          .object({
            key,
            name: text(120),
            slug: slug.optional(),
            parentKey: key.nullable().optional(),
          })
          .strict(),
      )
      .max(IMPORT_LIMITS.categories)
      .default([]),
    products: z.array(productSchema).min(1).max(IMPORT_LIMITS.products),
  })
  .strict();

export type ImportFile = z.infer<typeof importFileSchema>;
export type ImportProduct = ImportFile['products'][number];

export interface ImportIssue {
  path: string;
  message: string;
}

export interface PlannedCategory {
  key: string;
  name: string;
  slug: string;
  parentKey: string | null;
}
export interface PlannedProduct extends ImportProduct {
  /** Final slug: explicit, or derived deterministically (so a re-run finds the same product). */
  slug: string;
}
export interface ImportPlan {
  /** Parents always precede their children. */
  categories: PlannedCategory[];
  products: PlannedProduct[];
}

export type ParseResult =
  | { ok: true; plan: ImportPlan; file: ImportFile }
  | { ok: false; issues: ImportIssue[] };

const MAX_ISSUES = 100;

/** Decodes ONE level of the five HTML entities OpenCart's escaping produces. Sanitising still follows. */
export function decodeEntities(v: string): string {
  return v
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Validates shape AND cross-references (unknown categories, cycles, duplicate SKUs/slugs). Reports every problem at
 * once, so a bad file is fixed in one pass; nothing is planned unless the whole file is valid.
 */
export function parseImportFile(raw: unknown): ParseResult {
  const parsed = importFileSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.slice(0, MAX_ISSUES).map((i) => ({
        path: i.path.join('.') || '(file)',
        message: i.message,
      })),
    };
  }
  const file = parsed.data;
  const issues: ImportIssue[] = [];
  const add = (path: string, message: string) => {
    if (issues.length < MAX_ISSUES) issues.push({ path, message });
  };

  // --- categories
  const cats = new Map<string, PlannedCategory>();
  const catSlugs = new Set<string>();
  file.categories.forEach((c, i) => {
    if (cats.has(c.key))
      add(`categories.${i}.key`, `duplicate category key "${c.key}"`);
    const s = c.slug ?? slugify(c.name);
    if (catSlugs.has(s))
      add(`categories.${i}.slug`, `duplicate category slug "${s}"`);
    catSlugs.add(s);
    cats.set(c.key, {
      key: c.key,
      name: c.name,
      slug: s,
      parentKey: c.parentKey ?? null,
    });
  });
  for (const [i, c] of file.categories.entries()) {
    if (c.parentKey && !cats.has(c.parentKey))
      add(`categories.${i}.parentKey`, `unknown parent "${c.parentKey}"`);
  }
  // order parents first; anything left over is part of a cycle
  const ordered: PlannedCategory[] = [];
  const done = new Set<string>();
  let progress = true;
  while (progress && done.size < cats.size) {
    progress = false;
    for (const c of cats.values()) {
      if (done.has(c.key)) continue;
      if (
        c.parentKey === null ||
        done.has(c.parentKey) ||
        !cats.has(c.parentKey)
      ) {
        ordered.push(c);
        done.add(c.key);
        progress = true;
      }
    }
  }
  for (const c of cats.values())
    if (!done.has(c.key))
      add(`categories.${c.key}`, 'category parents form a cycle');

  // --- products
  const skus = new Map<string, string>();
  const explicit = new Set<string>();
  const used = new Set<string>();
  const planned: PlannedProduct[] = [];
  file.products.forEach((p, i) => {
    const where = `products.${i}${p.key ? ` (${p.key})` : ''}`;
    for (const k of p.categoryKeys)
      if (!cats.has(k)) add(`${where}.categoryKeys`, `unknown category "${k}"`);
    for (const v of p.variants) {
      const norm = v.sku.toLowerCase();
      const prev = skus.get(norm);
      if (prev)
        add(`${where}.variants`, `SKU "${v.sku}" is also used by ${prev}`);
      else skus.set(norm, where);
    }
    if (p.slug) {
      if (explicit.has(p.slug))
        add(`${where}.slug`, `duplicate slug "${p.slug}"`);
      explicit.add(p.slug);
    }
  });
  // Derived slugs: deterministic and collision-free inside the file (name, then name + first SKU, then a counter).
  for (const [i, p] of file.products.entries()) {
    let s = p.slug;
    if (!s) {
      const base = slugify(p.name, 150);
      s = base;
      if (used.has(s) || explicit.has(s))
        s = slugify(`${base}-${p.variants[0]!.sku}`, 160);
      for (let n = 2; used.has(s) || (explicit.has(s) && s !== p.slug); n++)
        s = slugify(`${base}-${p.variants[0]!.sku}-${n}`, 160);
    }
    used.add(s);
    planned[i] = {
      ...p,
      slug: s,
      descriptionHtml:
        p.descriptionHtml !== undefined &&
        file.options.decodeEntityEncodedDescriptions
          ? decodeEntities(p.descriptionHtml)
          : p.descriptionHtml,
    };
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, file, plan: { categories: ordered, products: planned } };
}
