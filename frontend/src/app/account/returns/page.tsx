"use client";

import React, { useState } from "react";
import Link from "next/link";
import { AccountShell, PanelEmpty, PanelError, PanelLoading, Pager } from "@/components/AccountShell";
import { accountApi, ACCOUNT_PAGE_SIZE, RETURN_REASONS } from "@/lib/account-api";
import { formatIndianDate } from "@/lib/formatters";
import { useAsync } from "@/lib/useAsync";

const STATUS: Record<string, { label: string; tone: string }> = {
  REQUESTED: { label: "Under review", tone: "bg-amber-50 text-amber-800" },
  APPROVED: { label: "Approved — ship it back", tone: "bg-[#E0EFE5] text-[#116644]" },
  REJECTED: { label: "Not approved", tone: "bg-red-50 text-red-700" },
  RECEIVED: { label: "Received", tone: "bg-[#E0EFE5] text-[#116644]" },
  REFUNDED: { label: "Refunded", tone: "bg-[#E0EFE5] text-[#116644]" },
};

export default function ReturnsPage() {
  const [page, setPage] = useState(1);
  const { data, error, loading, reload } = useAsync(() => accountApi.returns(page), [page]);

  return (
    <AccountShell title="My returns" subtitle="Track items you’ve sent back." crumbs={[{ label: "My returns" }]}>
      {loading && !data ? (
        <PanelLoading label="Loading your returns…" />
      ) : error ? (
        <PanelError message={error} onRetry={reload} />
      ) : !data || data.length === 0 ? (
        <PanelEmpty
          title={page === 1 ? "No returns" : "No more returns"}
          body="To return something, open a delivered order and choose “Return this item”."
          cta={page === 1 ? { label: "View my orders", href: "/account/orders" } : undefined}
        />
      ) : (
        <div className="space-y-4">
          <ul className="space-y-3">
            {data.map((r) => {
              const s = STATUS[r.status] ?? { label: r.status, tone: "bg-[#F2F5F3] text-[#4A5550]" };
              return (
                <li key={r.id} className="rounded-3xl border border-[#E6EAE7] bg-white p-5 space-y-2 min-w-0">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[14px] font-semibold text-[#113322]">{RETURN_REASONS[r.reason] ?? r.reason}</span>
                    <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${s.tone}`}>{s.label}</span>
                  </div>
                  <p className="text-[13px] text-[#4A5550]">
                    Qty {r.quantity} · requested {formatIndianDate(r.createdAt)}
                    {r.opened ? " · opened" : ""}
                  </p>
                  {r.decisionNote && <p className="text-[13px] text-[#4A5550] break-words">“{r.decisionNote}”</p>}
                  <Link href={`/account/orders/${r.orderId}`} className="text-[13px] font-semibold text-[#116644] hover:underline">
                    View order →
                  </Link>
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
