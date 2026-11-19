"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { X, Loader2 } from "lucide-react";
import { AnnouncementBar } from "@/components/AnnouncementBar";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { CartDrawer } from "@/components/CartDrawer";
import { ProductImage } from "@/components/ProductImage";
import { formatPaise } from "@/lib/formatters";
import { priceOf, type ProductDetail } from "@/lib/catalog-api";
import { ApiError, requestApi } from "@/lib/http";
import { useStore } from "@/lib/store";
import { useMounted } from "@/lib/useMounted";

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Lowest-priced in-stock variant (falls back to the first variant). */
function bestVariant(p: ProductDetail) {
  const pool = p.variants.filter((v) => v.inStock);
  const list = pool.length ? pool : p.variants;
  return list.reduce((a, b) => (b.price.amountMinor < a.price.amountMinor ? b : a), list[0]!);
}

export default function ComparePage() {
  const mounted = useMounted();
  const compareSlugs = useStore((s) => s.compareSlugs);
  const removeFromCompare = useStore((s) => s.removeFromCompare);
  const clearCompare = useStore((s) => s.clearCompare);
  const slugs = useMemo(() => compareSlugs.filter((s) => SLUG.test(s)).slice(0, 4), [compareSlugs]);
  const key = slugs.join(",");

  const [state, setState] = useState<{ key: string; products: ProductDetail[]; error: string | null } | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!mounted || !key) return;
    let cancelled = false;
    // One request per product so a product that was unpublished doesn't break the whole comparison.
    Promise.allSettled(
      key.split(",").map((s) => requestApi<ProductDetail>(`/catalog/products/${s}`)),
    ).then((results) => {
      if (cancelled) return;
      const products: ProductDetail[] = [];
      let failure: unknown = null;
      results.forEach((r, i) => {
        if (r.status === "fulfilled") products.push(r.value);
        else if (r.reason instanceof ApiError && r.reason.status === 404) removeFromCompare(key.split(",")[i]!);
        else failure = r.reason;
      });
      setState({
        key,
        products,
        error: failure && !products.length ? (failure instanceof ApiError ? failure.message : "Could not load your comparison.") : null,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [mounted, key, attempt, removeFromCompare]);

  const retry = useCallback(() => {
    setState(null);
    setAttempt((a) => a + 1);
  }, []);

  const loading = mounted && !!key && state?.key !== key;
  const products = useMemo(
    () => (state?.key === key ? state.products.filter((p) => slugs.includes(p.slug)) : []),
    [state, key, slugs],
  );

  // Union of attribute names across the compared products, in first-seen order.
  const attributeNames = useMemo(() => {
    const names: string[] = [];
    for (const p of products) for (const a of p.attributes) if (!names.includes(a.name)) names.push(a.name);
    return names;
  }, [products]);

  const cols = products.length + 1;
  const grid = { gridTemplateColumns: `minmax(140px, 1fr) repeat(${products.length}, minmax(180px, 1fr))` };
  const row = "grid gap-4 border-b border-[#F0F2F1] p-5 text-[14px] items-center";

  return (
    <>
      <AnnouncementBar />
      <Header />
      <CartDrawer />

      <main className="flex-1 max-w-[1600px] w-full mx-auto px-4 md:px-8 lg:px-12 py-6 space-y-6 min-w-0">
        <nav aria-label="Breadcrumb" className="text-[13px] text-[#8A958E] flex items-center gap-2">
          <Link href="/" className="hover:text-[#116644]">Home</Link>
          <span aria-hidden>/</span>
          <span className="text-[#113322] font-medium">Compare</span>
        </nav>

        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="font-heading text-[32px] md:text-[36px] font-bold text-[#113322]">A little side-by-side clarity.</h1>
            <p className="text-[14px] text-[#8A958E]">Compare up to 4 products. Find your perfect fit.</p>
          </div>
          {products.length > 0 && (
            <button type="button" onClick={clearCompare} className="text-[13px] font-semibold text-[#8A958E] hover:text-red-600">
              Clear all
            </button>
          )}
        </div>

        {!mounted || loading ? (
          <div role="status" className="flex items-center justify-center gap-2 rounded-3xl border border-[#E6EAE7] bg-white py-16 text-[14px] text-[#8A958E]">
            <Loader2 className="h-5 w-5 animate-spin text-[#116644]" aria-hidden /> Loading comparison…
          </div>
        ) : state?.error ? (
          <div role="alert" className="rounded-3xl border border-red-100 bg-red-50/60 px-6 py-12 text-center space-y-3">
            <p className="text-[14px] text-red-700">{state.error}</p>
            <button type="button" onClick={retry} className="rounded-xl border border-red-200 bg-white px-4 py-2 text-[13px] font-semibold text-red-700">
              Try again
            </button>
          </div>
        ) : products.length === 0 ? (
          <div className="bg-white rounded-3xl p-12 text-center border border-[#E6EAE7] space-y-4">
            <h2 className="font-heading text-xl font-bold text-[#113322]">No products in your comparison list yet.</h2>
            <p className="text-[14px] text-[#8A958E]">Open a product and choose “Compare” to add it here.</p>
            <Link href="/catalog" className="inline-block bg-[#116644] text-white font-semibold text-[14px] px-6 py-2.5 rounded-xl hover:bg-[#0e5237] transition">
              Browse Catalog →
            </Link>
          </div>
        ) : (
          <div className="bg-white rounded-3xl border border-[#E6EAE7] overflow-hidden shadow-xs">
            {products.length === 1 && (
              <p className="border-b border-[#F0F2F1] bg-[#EEFFEE]/50 px-5 py-3 text-[13px] text-[#116644]">
                Add another product to compare side by side.
              </p>
            )}
            <div className="overflow-x-auto">
              <div role="table" aria-label="Product comparison" aria-colcount={cols} className="min-w-max md:min-w-0">
                <div role="row" className="grid gap-4 border-b border-[#E6EAE7] p-5 items-end" style={grid}>
                  <div role="columnheader" className="space-y-1">
                    <h2 className="font-heading text-lg font-bold text-[#113322]">Your shortlist</h2>
                    <p className="text-[13px] text-[#8A958E]">The details that matter.</p>
                  </div>
                  {products.map((p) => (
                    <div role="columnheader" key={p.id} className="relative flex flex-col items-center text-center gap-3 rounded-2xl p-3">
                      <button
                        onClick={() => removeFromCompare(p.slug)}
                        className="absolute top-1 right-1 rounded-full p-1 text-[#8A958E] hover:text-red-500"
                        type="button"
                        aria-label={`Remove ${p.name} from comparison`}
                      >
                        <X className="w-4 h-4" />
                      </button>
                      <div className="relative w-36 h-28 rounded-xl overflow-hidden bg-[#F7F8F7]">
                        <ProductImage src={p.images.find((i) => i.url)?.url ?? null} alt={p.name} sizes="144px" />
                      </div>
                      <Link href={`/products/${p.slug}`} className="font-heading text-[15px] font-bold text-[#113322] line-clamp-2 break-words hover:text-[#116644]">
                        {p.name}
                      </Link>
                    </div>
                  ))}
                </div>

                <div role="row" className={row} style={grid}>
                  <span role="rowheader" className="font-medium text-[#8A958E]">Price · incl. of GST</span>
                  {products.map((p) => {
                    const { sale, regular, discounted } = priceOf(bestVariant(p).price);
                    return (
                      <div role="cell" key={p.id} className="text-center font-bold text-[#FF9900]">
                        {p.variants.length > 1 && <span className="mr-1 text-[12px] font-normal text-[#8A958E]">from</span>}
                        {formatPaise(sale)}
                        {discounted && <span className="ml-2 text-[12px] font-normal text-[#8A958E] line-through">{formatPaise(regular)}</span>}
                      </div>
                    );
                  })}
                </div>

                <div role="row" className={row} style={grid}>
                  <span role="rowheader" className="font-medium text-[#8A958E]">Availability</span>
                  {products.map((p) => {
                    const inStock = p.variants.some((v) => v.inStock);
                    return (
                      <div role="cell" key={p.id} className={`text-center font-medium ${inStock ? "text-[#116644]" : "text-[#B42318]"}`}>
                        {inStock ? "In stock" : "Out of stock"}
                      </div>
                    );
                  })}
                </div>

                <div role="row" className={row} style={grid}>
                  <span role="rowheader" className="font-medium text-[#8A958E]">Brand</span>
                  {products.map((p) => (
                    <div role="cell" key={p.id} className="text-center text-[#4A5550]">{p.brand?.name ?? "—"}</div>
                  ))}
                </div>

                <div role="row" className={row} style={grid}>
                  <span role="rowheader" className="font-medium text-[#8A958E]">Options</span>
                  {products.map((p) => (
                    <div role="cell" key={p.id} className="text-center text-[#4A5550]">
                      {p.variants.length} {p.variants.length === 1 ? "variant" : "variants"}
                    </div>
                  ))}
                </div>

                {attributeNames.map((name) => (
                  <div role="row" key={name} className={row} style={grid}>
                    <span role="rowheader" className="font-medium text-[#8A958E] break-words">{name}</span>
                    {products.map((p) => (
                      <div role="cell" key={p.id} className="text-center text-[#4A5550] break-words">
                        {p.attributes.find((a) => a.name === name)?.value ?? "—"}
                      </div>
                    ))}
                  </div>
                ))}

                <div role="row" className="grid gap-4 p-5 items-center bg-[#FAFAFA]" style={grid}>
                  <div role="cell" />
                  {products.map((p) => (
                    <div role="cell" key={p.id}>
                      <Link href={`/products/${p.slug}`} className="block text-center bg-[#FF9900] hover:bg-[#e68a00] text-[#113322] font-bold text-[14px] py-2.5 px-4 rounded-xl transition">
                        View product
                      </Link>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      <Footer />
    </>
  );
}
