"use client";

import React, { useState } from "react";
import Link from "next/link";
import { Trash2 } from "lucide-react";
import { AccountShell, PanelEmpty, PanelError, PanelLoading, Pager, secondaryButton } from "@/components/AccountShell";
import { ProductImage } from "@/components/ProductImage";
import { useWishlist } from "@/components/WishlistProvider";
import { accountApi, ACCOUNT_PAGE_SIZE, type WishlistItem } from "@/lib/account-api";
import { priceOf } from "@/lib/catalog-api";
import { formatPaise } from "@/lib/formatters";
import { useAsync } from "@/lib/useAsync";

export default function WishlistPage() {
  const [page, setPage] = useState(1);
  const { data, setData, error, loading, reload } = useAsync(() => accountApi.wishlist(page), [page]);
  const { forget } = useWishlist();
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const remove = async (p: WishlistItem) => {
    setBusy(p.slug);
    setActionError(null);
    try {
      await accountApi.removeFromWishlist(p.slug);
      setData((list) => (list ?? []).filter((x) => x.slug !== p.slug));
      forget(p.slug);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Could not remove the item.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <AccountShell title="Your wishlist" subtitle="Things you’ve saved for later." crumbs={[{ label: "Wishlist" }]}>
      {actionError && <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-[13px] text-red-700">{actionError}</p>}
      {loading && !data ? (
        <PanelLoading label="Loading your wishlist…" />
      ) : error ? (
        <PanelError message={error} onRetry={reload} />
      ) : !data || data.length === 0 ? (
        <PanelEmpty
          title={page === 1 ? "Your wishlist is empty" : "No more saved items"}
          body="Tap the heart on any product to save it here."
          cta={page === 1 ? { label: "Browse products", href: "/catalog" } : undefined}
        />
      ) : (
        <div className="space-y-4">
          <ul className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
            {data.map((p) => {
              const { sale, regular, discounted } = priceOf(p.price);
              return (
                <li key={p.id} className="flex flex-col overflow-hidden rounded-3xl border border-[#E6EAE7] bg-white min-w-0">
                  <Link href={`/products/${p.slug}`} className="relative block aspect-[4/3] bg-[#F7F8F7]">
                    <ProductImage src={p.imageUrl} alt={p.name} sizes="(min-width:1280px) 25vw, (min-width:640px) 40vw, 90vw" />
                  </Link>
                  <div className="flex flex-1 flex-col gap-3 p-4">
                    <div className="min-w-0 space-y-1">
                      <Link href={`/products/${p.slug}`} className="block font-heading text-[15px] font-bold text-[#113322] hover:text-[#116644] line-clamp-2">
                        {p.name}
                      </Link>
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span className="text-[15px] font-bold text-[#113322]">{formatPaise(sale)}</span>
                        {discounted && <span className="text-[12px] text-[#8A958E] line-through">{formatPaise(regular)}</span>}
                      </div>
                      <span className={`text-[12px] font-medium ${p.inStock ? "text-[#116644]" : "text-red-600"}`}>{p.inStock ? "In stock" : "Out of stock"}</span>
                    </div>
                    <div className="mt-auto flex flex-wrap gap-2">
                      <Link href={`/products/${p.slug}`} className="flex-1 rounded-xl bg-[#116644] px-4 py-2 text-center text-[13px] font-semibold text-white hover:bg-[#0e5237]">
                        {p.inStock ? "Choose options" : "View"}
                      </Link>
                      <button type="button" className={secondaryButton} disabled={busy === p.slug} onClick={() => remove(p)} aria-label={`Remove ${p.name} from wishlist`}>
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
          <Pager page={page} hasNext={data.length === ACCOUNT_PAGE_SIZE} onPage={setPage} />
        </div>
      )}
    </AccountShell>
  );
}
