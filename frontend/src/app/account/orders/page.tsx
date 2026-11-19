"use client";

import React, { useState } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { AccountShell, PanelEmpty, PanelError, PanelLoading, Pager } from "@/components/AccountShell";
import { ProductImage } from "@/components/ProductImage";
import { accountApi, ACCOUNT_PAGE_SIZE, ORDER_STATUS_LABEL, statusTone } from "@/lib/account-api";
import { formatIndianDate, formatPaise } from "@/lib/formatters";
import { useAsync } from "@/lib/useAsync";

export default function OrdersPage() {
  const [page, setPage] = useState(1);
  const { data, error, loading, reload } = useAsync(() => accountApi.orders(page), [page]);

  return (
    <AccountShell title="My orders" subtitle="Everything you’ve ordered from Yalli." crumbs={[{ label: "My orders" }]}>
      {loading && !data ? (
        <PanelLoading label="Loading your orders…" />
      ) : error ? (
        <PanelError message={error} onRetry={reload} />
      ) : !data || data.length === 0 ? (
        page === 1 ? (
          <PanelEmpty title="No orders yet" body="When you place an order it will show up here." cta={{ label: "Start shopping", href: "/catalog" }} />
        ) : (
          <PanelEmpty title="No more orders" body="You’ve reached the end of your order history." />
        )
      ) : (
        <div className={`space-y-4 ${loading ? "opacity-60" : ""}`} aria-busy={loading}>
          <ul className="space-y-4">
            {data.map((o) => (
              <li key={o.id}>
                <Link
                  href={`/account/orders/${o.id}`}
                  className="flex flex-col sm:flex-row sm:items-center gap-4 rounded-3xl border border-[#E6EAE7] bg-white p-5 hover:border-[#116644]/30 hover:shadow-sm transition min-w-0"
                >
                  <div className="flex -space-x-3 shrink-0">
                    {o.items.slice(0, 3).map((i, idx) => (
                      <div key={idx} className="relative h-14 w-14 overflow-hidden rounded-xl border-2 border-white bg-[#F7F8F7]">
                        <ProductImage src={i.imageUrl} alt="" sizes="56px" />
                      </div>
                    ))}
                  </div>
                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-heading text-[16px] font-bold text-[#113322]">{o.orderNumber}</span>
                      <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${statusTone(o.status)}`}>{ORDER_STATUS_LABEL[o.status]}</span>
                    </div>
                    <p className="text-[13px] text-[#4A5550] truncate">
                      {o.items.map((i) => i.productName).join(", ")}
                      {o.itemCount > o.items.length ? "…" : ""}
                    </p>
                    <p className="text-[12px] text-[#8A958E]">
                      {formatIndianDate(o.placedAt)} · {o.itemCount} {o.itemCount === 1 ? "item" : "items"}
                    </p>
                  </div>
                  <div className="flex items-center justify-between sm:justify-end gap-4 shrink-0">
                    <span className="font-heading text-[17px] font-bold text-[#113322]">{formatPaise(o.totals.totalMinor)}</span>
                    <ArrowRight className="h-5 w-5 text-[#8A958E]" aria-hidden />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
          <Pager page={page} hasNext={data.length === ACCOUNT_PAGE_SIZE} onPage={setPage} />
        </div>
      )}
    </AccountShell>
  );
}
