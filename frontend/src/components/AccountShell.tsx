'use client';

import Link from 'next/link';
import { AlertCircle, Loader2 } from 'lucide-react';
import { AnnouncementBar } from '@/components/AnnouncementBar';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { AccountSidebar } from '@/components/AccountSidebar';

/** Common chrome for every /account page: header, breadcrumb, sidebar, title and footer. */
export function AccountShell({
  title,
  subtitle,
  crumbs = [],
  actions,
  children,
}: {
  title: string;
  subtitle?: string;
  crumbs?: { label: string; href?: string }[];
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const trail = [{ label: 'Home', href: '/' }, { label: 'My account', href: '/account/orders' }, ...crumbs];
  return (
    <>
      <AnnouncementBar />
      <Header />
      <main className="flex-1 max-w-[1600px] w-full mx-auto px-4 md:px-8 lg:px-12 py-6 space-y-6 min-w-0">
        <nav aria-label="Breadcrumb" className="text-[13px] text-[#8A958E] flex flex-wrap items-center gap-2">
          {trail.map((c, i) => (
            <span key={c.label + i} className="flex items-center gap-2 min-w-0">
              {i > 0 && <span aria-hidden>/</span>}
              {c.href && i < trail.length - 1 ? (
                <Link href={c.href} className="hover:text-[#116644]">
                  {c.label}
                </Link>
              ) : (
                <span className="text-[#113322] font-medium truncate">{c.label}</span>
              )}
            </span>
          ))}
        </nav>
        <div className="flex flex-col lg:flex-row gap-4 lg:gap-8 items-start">
          <AccountSidebar />
          <div className="flex-1 w-full min-w-0 space-y-6">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div className="min-w-0">
                <h1 className="font-heading text-[28px] md:text-[32px] font-bold text-[#113322] break-words">{title}</h1>
                {subtitle && <p className="text-[14px] text-[#8A958E]">{subtitle}</p>}
              </div>
              {actions}
            </div>
            {children}
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
}

export function PanelLoading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div role="status" className="flex items-center justify-center gap-2 rounded-3xl border border-[#E6EAE7] bg-white py-16 text-[14px] text-[#8A958E]">
      <Loader2 className="h-5 w-5 animate-spin text-[#116644]" aria-hidden />
      {label}
    </div>
  );
}

export function PanelError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center gap-3 rounded-3xl border border-red-100 bg-red-50/60 px-6 py-12 text-center">
      <AlertCircle className="h-6 w-6 text-red-600" aria-hidden />
      <p className="text-[14px] text-red-700">{message}</p>
      {onRetry && (
        <button type="button" onClick={onRetry} className="rounded-xl border border-red-200 bg-white px-4 py-2 text-[13px] font-semibold text-red-700 hover:bg-red-50">
          Try again
        </button>
      )}
    </div>
  );
}

export function PanelEmpty({ title, body, cta }: { title: string; body: string; cta?: { label: string; href: string } }) {
  return (
    <div className="rounded-3xl border border-dashed border-[#D5DED8] bg-white px-6 py-14 text-center space-y-2">
      <p className="font-heading text-[18px] font-bold text-[#113322]">{title}</p>
      <p className="text-[14px] text-[#8A958E]">{body}</p>
      {cta && (
        <Link href={cta.href} className="inline-block pt-2 text-[14px] font-semibold text-[#116644] hover:underline">
          {cta.label} →
        </Link>
      )}
    </div>
  );
}

export function Pager({ page, hasNext, onPage }: { page: number; hasNext: boolean; onPage: (p: number) => void }) {
  if (page === 1 && !hasNext) return null;
  const btn = 'rounded-xl border border-[#E6EAE7] bg-white px-4 py-2 text-[13px] font-semibold text-[#113322] disabled:opacity-40';
  return (
    <nav aria-label="Pagination" className="flex items-center justify-center gap-3">
      <button type="button" className={btn} disabled={page <= 1} onClick={() => onPage(page - 1)}>
        ← Previous
      </button>
      <span className="text-[13px] text-[#8A958E]">Page {page}</span>
      <button type="button" className={btn} disabled={!hasNext} onClick={() => onPage(page + 1)}>
        Next →
      </button>
    </nav>
  );
}

export const inputClass =
  'w-full min-w-0 rounded-xl border border-[#E6EAE7] bg-white px-3.5 py-2.5 text-[14px] text-[#113322] outline-none focus:border-[#116644] focus:ring-2 focus:ring-[#116644]/15 disabled:bg-[#F7F8F7]';
export const primaryButton =
  'inline-flex items-center justify-center gap-2 rounded-xl bg-[#116644] px-5 py-2.5 text-[14px] font-semibold text-white hover:bg-[#0e5237] disabled:opacity-60';
export const secondaryButton =
  'inline-flex items-center justify-center gap-2 rounded-xl border border-[#E6EAE7] bg-white px-4 py-2 text-[13px] font-semibold text-[#113322] hover:border-[#116644]/40 disabled:opacity-60';
