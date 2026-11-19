import type { ReactNode } from 'react';
import Link from 'next/link';
import { AnnouncementBar } from '@/components/AnnouncementBar';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { CartDrawer } from '@/components/CartDrawer';

export interface PolicySection {
  id: string;
  title: string;
}

/** Shared frame for the help, policy and contact pages: store header and footer, one readable column, optional contents list. */
export function PolicyPage({
  title,
  intro,
  updated,
  sections,
  children,
}: {
  title: string;
  intro?: ReactNode;
  /** e.g. "19 November 2026". Shown as "Last updated" on the legal pages. */
  updated?: string;
  sections?: PolicySection[];
  children: ReactNode;
}) {
  return (
    <>
      <AnnouncementBar />
      <Header />
      <main id="content" className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 md:py-14">
        <nav aria-label="Breadcrumb" className="mb-4 text-[13px] text-[#4A5550]">
          <Link href="/" className="underline decoration-[#116644]/40 underline-offset-2 hover:text-[#116644]">
            Home
          </Link>{' '}
          <span aria-hidden="true">/</span> <span>{title}</span>
        </nav>
        <h1 className="font-heading text-[30px] font-bold leading-tight text-[#113322] md:text-[36px]">{title}</h1>
        {updated && <p className="mt-2 text-[13px] text-[#4A5550]">Last updated: {updated}</p>}
        {intro && <div className="mt-4 text-[16px] leading-relaxed text-[#2F3B35]">{intro}</div>}
        {sections && sections.length > 1 && (
          <nav aria-label="On this page" className="mt-6 rounded-2xl border border-[#E6EAE7] bg-white p-4">
            <p className="mb-2 text-[13px] font-semibold uppercase tracking-wider text-[#4A5550]">On this page</p>
            <ol className="grid gap-1 text-[14px] sm:grid-cols-2">
              {sections.map((s) => (
                <li key={s.id}>
                  <a href={`#${s.id}`} className="text-[#116644] underline underline-offset-2 hover:text-[#0e5237]">
                    {s.title}
                  </a>
                </li>
              ))}
            </ol>
          </nav>
        )}
        <div className="mt-8 space-y-10">{children}</div>
      </main>
      <Footer />
      <CartDrawer />
    </>
  );
}

export function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-24 space-y-3">
      <h2 id={`${id}-title`} className="font-heading text-[22px] font-semibold text-[#113322]">
        {title}
      </h2>
      <div className="space-y-3 text-[15px] leading-relaxed text-[#2F3B35] [overflow-wrap:anywhere]">{children}</div>
    </section>
  );
}

export function List({ children, ordered }: { children: ReactNode; ordered?: boolean }) {
  const Tag = ordered ? 'ol' : 'ul';
  return <Tag className={`space-y-1.5 pl-5 ${ordered ? 'list-decimal' : 'list-disc'} marker:text-[#116644]`}>{children}</Tag>;
}

/** A highlighted aside for the one thing a reader must not miss. */
export function Callout({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'owner' }) {
  const style = tone === 'owner' ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-[#CFE6D8] bg-[#EEFFEE] text-[#113322]';
  return <p className={`rounded-xl border px-4 py-3 text-[14px] ${style}`}>{children}</p>;
}

export const textLink =
  'font-medium text-[#116644] underline decoration-[#116644]/40 underline-offset-2 hover:text-[#0e5237] focus-visible:rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#116644]';

/** The single source of "today's" policy date so the three legal pages stay in step. */
export const POLICY_UPDATED = '19 November 2026';
