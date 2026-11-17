import { z } from 'zod';
import { paginationSchema } from '../../../common/http/pagination.js';
import { SLUG_PATTERN } from '../../../common/utils/slug.js';

const boolFlag = z.enum(['true', 'false']).transform((v) => v === 'true');
/** Strict ISO-8601 timestamp WITH timezone (e.g. 2026-11-20T00:00:00+05:30), converted to a Date. */
const isoDate = z.iso.datetime({ offset: true }).transform((v) => new Date(v));
const paise = z.coerce.number().int().min(0).max(1_000_000_000);

export const PRODUCT_SORTS = [
  'relevance',
  'newest',
  'name_asc',
  'name_desc',
  'price_asc',
  'price_desc',
] as const;

export const listProductsSchema = paginationSchema
  .extend({
    q: z.string().trim().min(1).max(100).optional(),
    category: z.string().regex(SLUG_PATTERN).max(120).optional(),
    brand: z.string().regex(SLUG_PATTERN).max(120).optional(),
    minPrice: paise.optional(),
    maxPrice: paise.optional(),
    inStock: boolFlag.optional(),
    special: boolFlag.optional(),
    sort: z.enum(PRODUCT_SORTS).optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.minPrice === undefined ||
      v.maxPrice === undefined ||
      v.minPrice <= v.maxPrice,
    { message: 'minPrice must not exceed maxPrice' },
  );
export type ListProductsQuery = z.infer<typeof listProductsSchema>;

export const slugParam = z.string().regex(SLUG_PATTERN).max(160);
export const uuidParam = z.uuid();

// ------------------------------------------------------------------------------------- admin

const name = (max: number) => z.string().trim().min(1).max(max);
/** GST slabs in basis points (0%, 0.25%, 3%, 5%, 12%, 18%, 28%, 40%). */
const gstRate = z.union(
  [0, 25, 300, 500, 1200, 1800, 2800, 4000].map((n) => z.literal(n)) as [
    z.ZodLiteral<number>,
    z.ZodLiteral<number>,
    ...z.ZodLiteral<number>[],
  ],
);
const price = z.number().int().min(1).max(1_000_000_000);
const sku = z
  .string()
  .trim()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,
    'SKU: letters, digits, . _ - (max 64)',
  );

export const variantSchema = z
  .object({
    sku,
    name: name(120).optional(),
    priceMinor: price,
    salePriceMinor: price.nullable().optional(),
    saleStartsAt: isoDate.nullable().optional(),
    saleEndsAt: isoDate.nullable().optional(),
    isActive: z.boolean().optional(),
    position: z.number().int().min(0).max(1000).optional(),
    weightGrams: z.number().int().min(0).max(1_000_000).nullable().optional(),
    optionValues: z
      .record(z.string().max(40), z.string().max(80))
      .nullable()
      .optional(),
  })
  .strict()
  .refine((v) => v.salePriceMinor == null || v.salePriceMinor < v.priceMinor, {
    message: 'salePriceMinor must be lower than priceMinor',
    path: ['salePriceMinor'],
  })
  .refine(
    (v) => !v.saleStartsAt || !v.saleEndsAt || v.saleEndsAt > v.saleStartsAt,
    { message: 'saleEndsAt must be after saleStartsAt', path: ['saleEndsAt'] },
  );

export const updateVariantSchema = z
  .object({
    name: name(120).nullable().optional(),
    priceMinor: price.optional(),
    salePriceMinor: price.nullable().optional(),
    saleStartsAt: isoDate.nullable().optional(),
    saleEndsAt: isoDate.nullable().optional(),
    isActive: z.boolean().optional(),
    position: z.number().int().min(0).max(1000).optional(),
    weightGrams: z.number().int().min(0).max(1_000_000).nullable().optional(),
    optionValues: z
      .record(z.string().max(40), z.string().max(80))
      .nullable()
      .optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

const productFields = {
  name: name(200),
  slug: z.string().regex(SLUG_PATTERN).max(160).optional(),
  summary: z.string().trim().max(500).optional(),
  descriptionHtml: z.string().max(50_000).optional(),
  brandId: z.uuid().nullable().optional(),
  categoryIds: z.array(z.uuid()).min(1).max(10),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  attributes: z
    .array(z.object({ name: name(80), value: name(300) }).strict())
    .max(50)
    .optional(),
  gstRateBps: gstRate.optional(),
  hsnCode: z
    .string()
    .regex(/^\d{4,8}$/)
    .nullable()
    .optional(),
};
export const createProductSchema = z
  .object({ ...productFields, variants: z.array(variantSchema).min(1).max(50) })
  .strict();
export const updateProductSchema = z
  .object(
    Object.fromEntries(
      Object.entries(productFields).map(([k, v]) => [
        k,
        (v as z.ZodType).optional(),
      ]),
    ) as {
      [K in keyof typeof productFields]: z.ZodOptional<
        (typeof productFields)[K]
      >;
    },
  )
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type CreateProductDto = z.infer<typeof createProductSchema>;
export type UpdateProductDto = z.infer<typeof updateProductSchema>;
export type VariantDto = z.infer<typeof variantSchema>;
export type UpdateVariantDto = z.infer<typeof updateVariantSchema>;

export const brandSchema = z
  .object({
    name: name(100),
    slug: z.string().regex(SLUG_PATTERN).max(120).optional(),
  })
  .strict();
export const categorySchema = z
  .object({
    name: name(100),
    slug: z.string().regex(SLUG_PATTERN).max(120).optional(),
    parentId: z.uuid().nullable().optional(),
    position: z.number().int().min(0).max(1000).optional(),
    isActive: z.boolean().optional(),
  })
  .strict();
export const updateCategorySchema = categorySchema
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

export const adminListSchema = paginationSchema
  .extend({
    q: z.string().trim().min(1).max(100).optional(),
    status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']).optional(),
  })
  .strict();
export const imageMetaSchema = z
  .object({
    altText: z.string().trim().max(200).optional(),
    variantId: z.uuid().optional(),
  })
  .strict();
