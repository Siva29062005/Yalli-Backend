'use client';

import type { ReactNode } from 'react';
import { AdminSidebar } from '@/components/AdminSidebar';
import type { PageMeta } from '@/lib/admin-api';

export const adminInput =
  'w-full min-w-0 rounded-xl border border-[#DCE3DE] bg-white px-3 py-2.5 text-sm outline-none focus:border-[#116644]';
export const adminButton =
  'rounded-xl bg-[#116644] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[#0e5237] disabled:opacity-50';
export const adminGhostButton =
  'rounded-xl border border-[#DCE3DE] bg-white px-4 py-2.5 text-sm font-semibold text-[#113322] transition hover:bg-[#F7F9F8] disabled:opacity-50';
export const adminDangerButton =
  'rounded-xl bg-red-700 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-red-800 disabled:opacity-50';
export const adminCard = 'rounded-2xl border border-[#E6EAE7] bg-white shadow-xs';

/** Sidebar + header + content frame shared by every staff screen. */
export function AdminPage({
  title,
  subtitle,
  eyebrow,
  actions,
  children,
}: {
  title: string;
  subtitle?: string;
  eyebrow?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-[#F7F9F8] md:flex-row">
      <AdminSidebar />
      <main className="min-w-0 flex-1 space-y-6 p-4 md:p-8 lg:p-10">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            {eyebrow && <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-[#116644]">{eyebrow}</p>}
            <h1 className="font-heading text-3xl font-bold text-[#113322]">{title}</h1>
            {subtitle && <p className="mt-2 max-w-xl text-sm text-[#4A5550]">{subtitle}</p>}
          </div>
          {actions}
        </header>
        {children}
      </main>
    </div>
  );
}

export function Alert({ kind, children }: { kind: 'error' | 'success' | 'warning'; children: ReactNode }) {
  const tone = {
    error: 'border-red-200 bg-red-50 text-red-800',
    success: 'border-green-200 bg-green-50 text-green-800',
    warning: 'border-amber-200 bg-amber-50 text-amber-900',
  }[kind];
  return (
    <div role={kind === 'error' ? 'alert' : 'status'} className={`rounded-xl border p-4 text-sm ${tone}`}>
      {children}
    </div>
  );
}

const PILL_TONES = {
  green: 'bg-[#EEFFEE] text-[#116644]',
  amber: 'bg-amber-50 text-amber-800',
  red: 'bg-red-50 text-red-700',
  blue: 'bg-blue-50 text-blue-700',
  gray: 'bg-gray-100 text-gray-600',
} as const;

export function Pill({ tone = 'gray', children }: { tone?: keyof typeof PILL_TONES; children: ReactNode }) {
  return <span className={`inline-block rounded-full px-2.5 py-1 text-[11px] font-semibold ${PILL_TONES[tone]}`}>{children}</span>;
}

/** Loading / error / empty states for a list or panel. Renders children only when there is something to show. */
export function DataState({
  loading,
  error,
  empty,
  emptyTitle = 'Nothing here yet',
  emptyHint,
  children,
}: {
  loading: boolean;
  error: string | null;
  empty: boolean;
  emptyTitle?: string;
  emptyHint?: string;
  children: ReactNode;
}) {
  if (loading) return <p role="status" className="p-8 text-sm text-[#4A5550]">Loading…</p>;
  if (error) return <div className="p-4"><Alert kind="error">{error}</Alert></div>;
  if (empty)
    return (
      <div className="p-10 text-center">
        <h2 className="font-semibold">{emptyTitle}</h2>
        {emptyHint && <p className="mt-2 text-sm text-[#4A5550]">{emptyHint}</p>}
      </div>
    );
  return <>{children}</>;
}

/**
 * After the last row of the last page is approved/deleted, the reloaded page can be past the end: step back to the last
 * page that exists. Call it in the list component's body (it adjusts that component's own state during render).
 * `meta.page === page` makes sure the answer belongs to the page being shown, not an older request.
 */
export function useClampedPage(meta: PageMeta | undefined, page: number, setPage: (page: number) => void) {
  if (meta && meta.page === page && page > 1 && meta.totalPages < page) setPage(Math.max(1, meta.totalPages));
}

export function Pager({ meta, onPage }: { meta: PageMeta; onPage: (page: number) => void }) {
  if (meta.totalPages <= 1) return null;
  return (
    <nav aria-label="Pagination" className="flex items-center justify-between gap-3 border-t border-[#E6EAE7] p-4 text-sm">
      <span className="text-[#4A5550]">
        Page {meta.page} of {meta.totalPages} · {meta.total} total
      </span>
      <div className="flex gap-2">
        <button type="button" className={adminGhostButton} disabled={meta.page <= 1} onClick={() => onPage(meta.page - 1)}>
          Previous
        </button>
        <button type="button" className={adminGhostButton} disabled={meta.page >= meta.totalPages} onClick={() => onPage(meta.page + 1)}>
          Next
        </button>
      </div>
    </nav>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block text-sm font-medium">
      {label}
      <div className="mt-1">{children}</div>
      {hint && <span className="mt-1 block text-xs font-normal text-[#4A5550]">{hint}</span>}
    </label>
  );
}
