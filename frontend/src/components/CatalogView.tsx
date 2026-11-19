'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Search, ChevronDown, SlidersHorizontal, X } from 'lucide-react';
import { useCategories } from '@/components/CategoryProvider';
import { ProductCard } from '@/components/ProductCard';
import type { Brand, ProductPage, ProductQuery } from '@/lib/catalog-api';

const SORT_LABELS: Record<string, string> = {
  relevance: 'Relevance',
  newest: 'Newest',
  price_asc: 'Price: Low to High',
  price_desc: 'Price: High to Low',
  name_asc: 'Name: A–Z',
  name_desc: 'Name: Z–A',
};

interface Props {
  page: ProductPage | null;
  error: string | null;
  brands: Brand[];
  query: ProductQuery;
  categorySlug?: string;
}

export function CatalogView({ page, error, brands, query, categorySlug }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const { categories } = useCategories();
  const [search, setSearch] = useState(query.q ?? '');
  const [min, setMin] = useState(params.get('min') ?? '');
  const [max, setMax] = useState(params.get('max') ?? '');
  const [filtersOpen, setFiltersOpen] = useState(false);

  // Keep the box in sync when the header search changes `q` (adjust state during render, not in an effect).
  const [syncedQ, setSyncedQ] = useState(query.q);
  if (syncedQ !== query.q) {
    setSyncedQ(query.q);
    setSearch(query.q ?? '');
  }

  const navigate = (updates: Record<string, string | null>, base = pathname) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(updates)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    if (!('page' in updates)) next.delete('page');
    const qs = next.toString();
    startTransition(() => router.push(qs ? `${base}?${qs}` : base, { scroll: false }));
  };

  const goCategory = (slug: string | null) => {
    const keep = new URLSearchParams(params.toString());
    keep.delete('page');
    const qs = keep.toString();
    const base = slug ? `/catalog/${slug}` : '/catalog';
    startTransition(() => router.push(qs ? `${base}?${qs}` : base));
  };

  const category = categories.find((c) => c.slug === categorySlug);
  const title = query.q
    ? `Results for “${query.q}”`
    : category?.name ?? (categorySlug ? 'Category' : 'All products');
  const total = page?.meta.total ?? 0;
  const totalPages = page?.meta.totalPages ?? 0;
  const current = query.page ?? 1;
  const activeFilters =
    !!query.brand || !!query.inStock || !!query.special || query.minPrice !== undefined || query.maxPrice !== undefined;

  const pageHref = (n: number) => {
    const next = new URLSearchParams(params.toString());
    if (n > 1) next.set('page', String(n));
    else next.delete('page');
    const qs = next.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  };

  const filters = (
    <div className="space-y-6">
      <div className="flex items-center justify-between border-b border-[#F0F2F1] pb-4">
        <h2 className="font-heading text-[16px] font-bold text-[#113322]">Filters</h2>
        {activeFilters && (
          <button
            type="button"
            onClick={() => {
              setMin('');
              setMax('');
              navigate({ brand: null, inStock: null, sale: null, min: null, max: null });
            }}
            className="text-[12px] font-semibold text-[#116644] hover:underline"
          >
            Clear all
          </button>
        )}
      </div>

      <fieldset className="space-y-2">
        <legend className="mb-2 block text-[11px] font-bold uppercase tracking-wider text-[#8A958E]">
          Category
        </legend>
        <div className="max-h-72 space-y-1 overflow-y-auto pr-1 text-[13px]">
          {categories.map((c) => {
            const slug = c.slug === 'all-products' ? null : c.slug;
            const checked = (categorySlug ?? null) === slug;
            return (
              <label key={c.id} className="flex cursor-pointer items-center gap-2.5 py-1 text-[#113322]">
                <input
                  type="radio"
                  name="category"
                  checked={checked}
                  onChange={() => goCategory(slug)}
                  className="h-4 w-4 accent-[#116644]"
                />
                <span className={`min-w-0 flex-1 truncate ${checked ? 'font-semibold text-[#116644]' : ''}`}>
                  {c.name}
                </span>
                {c.productCount !== undefined && slug && (
                  <span className="text-[11px] text-[#8A958E]">{c.productCount}</span>
                )}
              </label>
            );
          })}
        </div>
      </fieldset>

      {brands.length > 0 && (
        <fieldset className="space-y-2 border-t border-[#F0F2F1] pt-4">
          <legend className="mb-2 block text-[11px] font-bold uppercase tracking-wider text-[#8A958E]">
            Brand
          </legend>
          <div className="max-h-56 space-y-1 overflow-y-auto pr-1 text-[13px]">
            {brands.map((b) => (
              <label key={b.slug} className="flex cursor-pointer items-center gap-2.5 py-1 text-[#113322]">
                <input
                  type="checkbox"
                  checked={query.brand === b.slug}
                  onChange={(e) => navigate({ brand: e.target.checked ? b.slug : null })}
                  className="h-4 w-4 accent-[#116644]"
                />
                <span className="min-w-0 flex-1 truncate">{b.name}</span>
                <span className="text-[11px] text-[#8A958E]">{b.productCount}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <form
        className="space-y-2 border-t border-[#F0F2F1] pt-4"
        onSubmit={(e) => {
          e.preventDefault();
          navigate({ min: min.trim() || null, max: max.trim() || null });
        }}
      >
        <span className="block text-[11px] font-bold uppercase tracking-wider text-[#8A958E]">Price (₹)</span>
        <div className="flex items-center gap-2">
          <input
            inputMode="numeric"
            aria-label="Minimum price in rupees"
            placeholder="Min"
            value={min}
            onChange={(e) => setMin(e.target.value.replace(/[^\d]/g, ''))}
            className="w-full min-w-0 rounded-lg border border-[#E6EAE7] px-3 py-1.5 text-[13px] outline-none focus:border-[#116644]"
          />
          <span className="text-[#8A958E]">–</span>
          <input
            inputMode="numeric"
            aria-label="Maximum price in rupees"
            placeholder="Max"
            value={max}
            onChange={(e) => setMax(e.target.value.replace(/[^\d]/g, ''))}
            className="w-full min-w-0 rounded-lg border border-[#E6EAE7] px-3 py-1.5 text-[13px] outline-none focus:border-[#116644]"
          />
          <button
            type="submit"
            className="shrink-0 rounded-lg bg-[#116644] px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-[#0e5237]"
          >
            Go
          </button>
        </div>
      </form>

      <div className="space-y-2 border-t border-[#F0F2F1] pt-4 text-[13px]">
        <label className="flex cursor-pointer items-center gap-2.5 py-1">
          <input
            type="checkbox"
            checked={!!query.inStock}
            onChange={(e) => navigate({ inStock: e.target.checked ? 'true' : null })}
            className="h-4 w-4 accent-[#116644]"
          />
          In stock only
        </label>
        <label className="flex cursor-pointer items-center gap-2.5 py-1">
          <input
            type="checkbox"
            checked={!!query.special}
            onChange={(e) => navigate({ sale: e.target.checked ? 'true' : null })}
            className="h-4 w-4 accent-[#116644]"
          />
          On sale
        </label>
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 text-[13px] text-[#8A958E]">
        <Link href="/" className="hover:text-[#116644]">Home</Link>
        <span>/</span>
        {categorySlug ? (
          <>
            <Link href="/catalog" className="hover:text-[#116644]">Shop</Link>
            <span>/</span>
            <span className="truncate font-medium text-[#113322]">{category?.name ?? categorySlug}</span>
          </>
        ) : (
          <span className="font-medium text-[#113322]">Shop</span>
        )}
      </nav>

      <div className="min-w-0">
        <h1 className="break-words font-heading text-[28px] font-bold text-[#113322] md:text-[36px]">{title}</h1>
        <p className="text-[14px] text-[#8A958E]">Everyday essentials. Extraordinary little moments.</p>
      </div>

      <div className="grid grid-cols-1 items-start gap-8 pt-2 lg:grid-cols-12">
        <aside className="hidden rounded-2xl border border-[#E6EAE7] bg-white p-6 lg:col-span-3 lg:block">
          {filters}
        </aside>

        {filtersOpen && (
          <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Filters">
            <button
              type="button"
              aria-label="Close filters"
              className="absolute inset-0 bg-black/40"
              onClick={() => setFiltersOpen(false)}
            />
            <div className="absolute inset-y-0 left-0 w-[min(340px,88vw)] overflow-y-auto bg-white p-6 shadow-xl">
              <button
                type="button"
                onClick={() => setFiltersOpen(false)}
                aria-label="Close filters"
                className="absolute right-4 top-5 rounded-full p-1 hover:bg-[#F5F6F5]"
              >
                <X className="h-5 w-5" />
              </button>
              {filters}
            </div>
          </div>
        )}

        <section className="min-w-0 space-y-6 lg:col-span-9" aria-busy={pending}>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#E6EAE7] bg-white p-4">
            <button
              type="button"
              onClick={() => setFiltersOpen(true)}
              className="flex items-center gap-1.5 rounded-lg border border-[#E6EAE7] px-3 py-1.5 text-[13px] font-semibold text-[#113322] lg:hidden"
            >
              <SlidersHorizontal className="h-4 w-4" /> Filters
            </button>

            <span className="text-[13px] text-[#8A958E]" aria-live="polite">
              <strong className="font-semibold text-[#113322]">{total}</strong>{' '}
              {total === 1 ? 'product' : 'products'}
            </span>

            <form
              role="search"
              className="relative order-last w-full sm:order-none sm:w-auto sm:max-w-xs sm:flex-1"
              onSubmit={(e) => {
                e.preventDefault();
                navigate({ q: search.trim() || null, sort: null });
              }}
            >
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#8A958E]" />
              <input
                type="search"
                aria-label="Search products"
                placeholder="Search products..."
                maxLength={100}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full rounded-lg border border-transparent bg-[#F5F6F5] py-1.5 pl-9 pr-3 text-[13px] text-[#113322] outline-none focus:border-[#116644] focus:bg-white"
              />
            </form>

            <label className="flex items-center gap-2 text-[13px]">
              <span className="text-[#8A958E]">Sort:</span>
              <span className="relative">
                <select
                  value={query.sort ?? (query.q ? 'relevance' : 'newest')}
                  onChange={(e) => navigate({ sort: e.target.value })}
                  className="cursor-pointer appearance-none rounded-lg border border-transparent bg-[#F5F6F5] py-1.5 pl-3 pr-8 font-medium text-[#113322] outline-none focus:border-[#116644]"
                >
                  {Object.entries(SORT_LABELS)
                    .filter(([k]) => k !== 'relevance' || query.q)
                    .map(([k, label]) => (
                      <option key={k} value={k}>{label}</option>
                    ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#8A958E]" />
              </span>
            </label>
          </div>

          {error ? (
            <div role="alert" className="space-y-3 rounded-2xl border border-[#F3D6D6] bg-white p-12 text-center">
              <p className="text-base font-semibold text-[#113322]">We couldn’t load products right now.</p>
              <p className="text-[13px] text-[#8A958E]">{error}</p>
              <button
                type="button"
                onClick={() => startTransition(() => router.refresh())}
                className="rounded-lg bg-[#116644] px-4 py-2 text-[13px] font-semibold text-white hover:bg-[#0e5237]"
              >
                Try again
              </button>
            </div>
          ) : !page || page.items.length === 0 ? (
            <div className="space-y-3 rounded-2xl border border-[#E6EAE7] bg-white p-12 text-center">
              <p className="text-base font-semibold text-[#113322]">No products match your filters.</p>
              <p className="text-[13px] text-[#8A958E]">Try another category, a wider price range, or a different search.</p>
              <Link href="/catalog" className="inline-block text-[13px] font-semibold text-[#116644] hover:underline">
                View all products
              </Link>
            </div>
          ) : (
            <div
              className={`grid grid-cols-1 gap-6 transition-opacity sm:grid-cols-2 xl:grid-cols-3 ${pending ? 'opacity-60' : ''}`}
            >
              {page.items.map((p, i) => (
                <ProductCard key={p.id} product={p} priority={i < 3} />
              ))}
            </div>
          )}

          {totalPages > 1 && (
            <nav aria-label="Pagination" className="flex flex-wrap items-center justify-center gap-2 pt-6">
              <PageLink href={pageHref(current - 1)} disabled={current <= 1}>← Previous</PageLink>
              {pageNumbers(current, totalPages).map((n, i) =>
                n === null ? (
                  <span key={`gap-${i}`} className="px-1 text-[#8A958E]">…</span>
                ) : (
                  <Link
                    key={n}
                    href={pageHref(n)}
                    aria-current={n === current ? 'page' : undefined}
                    className={`flex h-9 w-9 items-center justify-center rounded-lg text-[13px] font-semibold ${
                      n === current
                        ? 'bg-[#116644] text-white'
                        : 'border border-[#E6EAE7] bg-white text-[#113322] hover:bg-[#F5F6F5]'
                    }`}
                  >
                    {n}
                  </Link>
                ),
              )}
              <PageLink href={pageHref(current + 1)} disabled={current >= totalPages}>Next →</PageLink>
            </nav>
          )}
        </section>
      </div>
    </div>
  );
}

function PageLink({ href, disabled, children }: { href: string; disabled: boolean; children: React.ReactNode }) {
  const cls = 'rounded-lg border border-[#E6EAE7] bg-white px-4 py-2 text-[13px] font-medium text-[#113322]';
  return disabled ? (
    <span aria-disabled className={`${cls} opacity-50`}>{children}</span>
  ) : (
    <Link href={href} className={`${cls} hover:bg-[#F5F6F5]`}>{children}</Link>
  );
}

/** 1 … 4 5 6 … 20 */
export function pageNumbers(current: number, total: number): (number | null)[] {
  const set = new Set([1, total, current - 1, current, current + 1].filter((n) => n >= 1 && n <= total));
  const sorted = [...set].sort((a, b) => a - b);
  return sorted.flatMap((n, i) => (i > 0 && n - sorted[i - 1]! > 1 ? [null, n] : [n]));
}
