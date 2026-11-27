import { ApiError, API_BASE_URL } from './http';
import type { CategoryNode } from './category-utils';

/** Shapes returned by the public catalogue API (`src/modules/catalog/catalog-query.service.ts`). */
export interface Money {
  amountMinor: number;
  compareAtMinor: number | null;
  onSale: boolean;
  currency: string;
}

export interface ProductSummary {
  id: string;
  slug: string;
  name: string;
  summary?: string | null;
  brand: { name: string | null; slug: string } | null;
  price: Money;
  inStock: boolean;
  imageUrl: string | null;
  /** Approved-review rating; absent from older API builds. */
  rating?: { average: number | null; count: number };
}

export interface ProductVariantDetail {
  id: string;
  sku: string;
  name: string | null;
  optionValues: Record<string, string> | null;
  price: Money;
  inStock: boolean;
  lowStock: boolean;
}

export interface ProductDetail {
  id: string;
  slug: string;
  name: string;
  summary: string | null;
  descriptionHtml: string | null;
  brand: { name: string; slug: string } | null;
  categories: { name: string; slug: string }[];
  tags: string[];
  attributes: { name: string; value: string }[];
  images: { url: string | null; altText: string | null; variantId: string | null }[];
  gstRateBps: number;
  variants: ProductVariantDetail[];
}

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface ProductPage {
  items: ProductSummary[];
  meta: PageMeta;
}

export interface Brand {
  name: string;
  slug: string;
  productCount: number;
}

export interface RatingSummary {
  count: number;
  average: number | null;
  distribution: Record<'1' | '2' | '3' | '4' | '5', number>;
}

export interface Review {
  id: string;
  rating: number;
  title: string | null;
  body: string;
  verifiedPurchase: boolean;
  reviewer: string;
  createdAt: string;
}

export const PRODUCT_SORTS = [
  'relevance',
  'newest',
  'price_asc',
  'price_desc',
  'name_asc',
  'name_desc',
] as const;
export type ProductSort = (typeof PRODUCT_SORTS)[number];

export interface ProductQuery {
  q?: string;
  category?: string;
  brand?: string;
  minPrice?: number;
  maxPrice?: number;
  inStock?: boolean;
  special?: boolean;
  sort?: ProductSort;
  page?: number;
  pageSize?: number;
}

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const PAGE_SIZE = 24;

/** Turns untrusted URL search params into a query the API will accept (invalid values are dropped, never sent). */
export function parseProductQuery(
  params: Record<string, string | string[] | undefined>,
  category?: string,
): ProductQuery {
  const one = (k: string) => {
    const v = params[k];
    return (Array.isArray(v) ? v[0] : v)?.trim() || undefined;
  };
  const rupees = (k: string) => {
    const v = Number(one(k));
    return Number.isFinite(v) && v >= 0 && v <= 10_000_000
      ? Math.round(v * 100)
      : undefined;
  };
  const q = one('q')?.slice(0, 100);
  const sort = one('sort');
  const page = Number(one('page'));
  const brand = one('brand');
  let minPrice = rupees('min');
  let maxPrice = rupees('max');
  if (minPrice !== undefined && maxPrice !== undefined && minPrice > maxPrice)
    [minPrice, maxPrice] = [maxPrice, minPrice];
  return {
    q,
    category: category && SLUG.test(category) ? category : undefined,
    brand: brand && SLUG.test(brand) ? brand : undefined,
    minPrice,
    maxPrice,
    inStock: one('inStock') === 'true' || undefined,
    special: one('sale') === 'true' || undefined,
    sort:
      sort && (PRODUCT_SORTS as readonly string[]).includes(sort)
        ? (sort as ProductSort)
        : undefined,
    page: Number.isInteger(page) && page >= 1 && page <= 10_000 ? page : 1,
    pageSize: PAGE_SIZE,
  };
}

function toSearch(query: ProductQuery): string {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === '') continue;
    // `relevance` is only valid alongside a search term.
    if (k === 'sort' && v === 'relevance' && !query.q) continue;
    s.set(k, String(v));
  }
  return s.toString();
}

/** Fetches an API envelope, returning `data` and `meta`. Errors carry the HTTP status (404 → not found). */
async function get<T>(path: string, revalidate = 30): Promise<{ data: T; meta: unknown }> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      headers: { Accept: 'application/json' },
      next: { revalidate },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new ApiError('Unable to reach the store. Please try again.', 0);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.success) {
    throw new ApiError(
      body?.message || 'The store could not load this content.',
      res.status,
      body?.error?.code,
    );
  }
  return { data: body.data as T, meta: body.meta };
}

export async function listProducts(query: ProductQuery): Promise<ProductPage> {
  const { data, meta } = await get<ProductSummary[]>(
    `/catalog/products?${toSearch(query)}`,
  );
  return {
    items: data,
    meta: (meta as PageMeta) ?? {
      page: 1,
      pageSize: data.length,
      total: data.length,
      totalPages: 1,
    },
  };
}

export async function getProduct(slug: string): Promise<ProductDetail | null> {
  if (!SLUG.test(slug)) return null;
  try {
    return (await get<ProductDetail>(`/catalog/products/${slug}`)).data;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/** Category tree for the sitemap (the storefront menu loads it in the browser instead). */
export async function listCategoryTree(): Promise<CategoryNode[]> {
  return (await get<CategoryNode[]>('/catalog/categories', 300)).data;
}

/** Every published product slug, a page at a time (bounded so a bad `totalPages` can never loop forever). */
export async function listAllProductSlugs(maxPages = 200): Promise<string[]> {
  const slugs: string[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const { items, meta } = await listProducts({ page, pageSize: 60 });
    slugs.push(...items.map((p) => p.slug));
    if (page >= meta.totalPages || items.length === 0) break;
  }
  return slugs;
}

export async function listBrands(): Promise<Brand[]> {
  return (await get<Brand[]>('/catalog/brands', 60)).data;
}

export async function getReviews(slug: string) {
  const [summary, list] = await Promise.all([
    get<RatingSummary>(`/catalog/products/${slug}/reviews/summary`),
    get<Review[]>(`/catalog/products/${slug}/reviews?pageSize=6`),
  ]);
  return { summary: summary.data, reviews: list.data };
}

export function priceOf(m: Money) {
  const regular = m.compareAtMinor ?? m.amountMinor;
  return {
    sale: m.amountMinor,
    regular,
    discounted: m.onSale && regular > m.amountMinor,
  };
}

export function variantLabel(v: ProductVariantDetail): string {
  if (v.name) return v.name;
  const values = Object.values(v.optionValues ?? {});
  return values.length ? values.join(' / ') : v.sku;
}
