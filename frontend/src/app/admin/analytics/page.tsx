'use client';

import { useState } from 'react';
import { Alert, AdminPage, Pill, adminButton, adminCard, adminGhostButton, adminInput } from '@/components/AdminKit';
import { adminGet } from '@/lib/admin-api';
import { useAdminQuery } from '@/lib/useAdminQuery';
import { ORDER_STATUS_LABEL } from '@/lib/account-api';
import type { OrderStatus } from '@/lib/checkout-api';
import { axisTicks, formatAxisMoney, istToday, presetRange, rangeProblem } from '@/lib/analytics-utils';
import { formatIndianDate, formatPaise } from '@/lib/formatters';

interface Range { from: string; to: string; days: number }
interface Overview {
  range: Range;
  paidOrders: number;
  uniqueBuyers: number;
  grossMinor: number;
  refundedMinor: number;
  refundCount: number;
  netMinor: number;
  averageOrderValueMinor: number;
  discountMinor: number;
  shippingMinor: number;
  gstIncludedMinor: number;
  ordersPlacedByStatus: Record<string, number>;
}
interface SalesByDay { days: { date: string; paidOrders: number; grossMinor: number }[] }
interface TopProducts { products: { productId: string; name: string; units: number; revenueMinor: number }[] }
interface GstSummary {
  byRate: { rateBps: number; taxableValueMinor: number; cgstMinor: number; sgstMinor: number; igstMinor: number; totalGstMinor: number }[];
  totals: { taxableValueMinor: number; cgstMinor: number; sgstMinor: number; igstMinor: number; totalGstMinor: number };
  notes: string[];
}

const PRESETS = [{ label: 'Today', days: 1 }, { label: 'Last 7 days', days: 7 }, { label: 'Last 30 days', days: 30 }, { label: 'Last 90 days', days: 90 }];
const dayLabel = (date: string) => formatIndianDate(`${date}T00:00:00+05:30`).replace(/ \d{4}$/, '');

export default function AdminAnalyticsPage() {
  const [range, setRange] = useState(() => presetRange(30));
  const [draft, setDraft] = useState(range);
  const [problem, setProblem] = useState<string | null>(null);
  const [by, setBy] = useState<'revenue' | 'units'>('revenue');

  const report = useAdminQuery(async () => {
    const q = { from: range.from, to: range.to };
    const [overview, sales, gst] = await Promise.all([
      adminGet<Overview>('/admin/analytics/overview', q),
      adminGet<SalesByDay>('/admin/analytics/sales-by-day', q),
      adminGet<GstSummary>('/admin/analytics/gst-summary', q),
    ]);
    return { overview, sales, gst };
  }, [range.from, range.to]);
  const top = useAdminQuery(() => adminGet<TopProducts>('/admin/analytics/top-products', { from: range.from, to: range.to, by, limit: 10 }), [range.from, range.to, by]);

  function apply(next: { from: string; to: string }) {
    const issue = rangeProblem(next.from, next.to);
    setProblem(issue);
    if (issue) return;
    setDraft(next);
    setRange(next);
  }

  const data = report.data;
  const refreshing = report.loading && data !== null;
  const o = data?.overview;
  const today = istToday();

  return (
    <AdminPage eyebrow="Overview" title="The everyday, at a glance." subtitle="Reporting only: totals, no customer details. Days are India days. An order counts on the day it was paid.">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          apply(draft);
        }}
      >
        <div className="flex flex-wrap gap-2" role="group" aria-label="Date presets">
          {PRESETS.map((p) => {
            const preset = presetRange(p.days);
            const active = range.from === preset.from && range.to === preset.to;
            return <button type="button" key={p.days} aria-pressed={active} className={active ? adminButton : adminGhostButton} onClick={() => apply(preset)}>{p.label}</button>;
          })}
        </div>
        <label className="text-sm">From<input type="date" max={today} className={`${adminInput} mt-1`} value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} /></label>
        <label className="text-sm">To<input type="date" max={today} className={`${adminInput} mt-1`} value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} /></label>
        <button className={adminGhostButton}>Apply range</button>
      </form>
      {problem && <Alert kind="warning">{problem}</Alert>}
      {report.error && <Alert kind="error">{report.error}</Alert>}
      {!data && !report.error && <p role="status" className="text-sm text-[#4A5550]">Loading the numbers…</p>}

      {o && data && (
        <div className={`space-y-6 transition-opacity ${refreshing ? 'opacity-60' : ''}`} aria-busy={refreshing}>
          <p className="text-sm text-[#4A5550]">{formatIndianDate(`${o.range.from}T00:00:00+05:30`)} – {formatIndianDate(`${o.range.to}T00:00:00+05:30`)} · {o.range.days} day{o.range.days === 1 ? '' : 's'} · IST</p>

          <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-6">
            <Stat label="Revenue (paid)" value={formatPaise(o.grossMinor)} />
            <Stat label="Paid orders" value={o.paidOrders.toLocaleString('en-IN')} />
            <Stat label="Average order" value={formatPaise(o.averageOrderValueMinor)} />
            <Stat label="Refunded" value={formatPaise(o.refundedMinor)} hint={`${o.refundCount} refund${o.refundCount === 1 ? '' : 's'}`} />
            <Stat label="Net revenue" value={formatPaise(o.netMinor)} hint="after refunds" />
            <Stat label="Customers who paid" value={o.uniqueBuyers.toLocaleString('en-IN')} />
          </div>
          <p className="text-sm text-[#4A5550]">
            Of the revenue: GST included {formatPaise(o.gstIncludedMinor)} · delivery charged {formatPaise(o.shippingMinor)} · discounts given {formatPaise(o.discountMinor)}.
          </p>

          <SalesChart days={data.sales.days} />

          <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
            <section className={`${adminCard} min-w-0 p-5`}>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <h2 className="font-heading text-lg font-bold">Top products</h2>
                <select aria-label="Rank products by" className="rounded-xl border border-[#DCE3DE] bg-white p-2 text-sm" value={by} onChange={(e) => setBy(e.target.value as 'revenue' | 'units')}>
                  <option value="revenue">By revenue</option>
                  <option value="units">By units sold</option>
                </select>
              </div>
              {top.error ? <Alert kind="error">{top.error}</Alert> : !top.data ? <p role="status" className="text-sm">Loading…</p> : top.data.products.length === 0 ? <p className="text-sm text-[#4A5550]">No sales in this period.</p> : (
                <ol className={`divide-y divide-[#E6EAE7] text-sm ${top.loading ? 'opacity-60' : ''}`}>
                  {top.data.products.map((p, i) => (
                    <li key={p.productId} className="flex items-center justify-between gap-3 py-2.5">
                      <span className="min-w-0 break-words"><span className="mr-2 text-[#4A5550]">{i + 1}.</span>{p.name}</span>
                      <span className="shrink-0 text-right"><strong>{formatPaise(p.revenueMinor)}</strong><span className="block text-xs text-[#4A5550]">{p.units} sold</span></span>
                    </li>
                  ))}
                </ol>
              )}
            </section>

            <section className={`${adminCard} min-w-0 p-5`}>
              <h2 className="mb-3 font-heading text-lg font-bold">Orders placed, by status</h2>
              {Object.keys(o.ordersPlacedByStatus).length === 0 ? <p className="text-sm text-[#4A5550]">No orders placed in this period.</p> : (
                <ul className="divide-y divide-[#E6EAE7] text-sm">
                  {Object.entries(o.ordersPlacedByStatus).map(([status, count]) => (
                    <li key={status} className="flex items-center justify-between py-2.5"><Pill tone="gray">{ORDER_STATUS_LABEL[status as OrderStatus] ?? status}</Pill><strong>{count}</strong></li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <section className={`${adminCard} min-w-0 p-5`}>
            <h2 className="mb-3 font-heading text-lg font-bold">GST summary</h2>
            {data.gst.byRate.length === 0 ? <p className="text-sm text-[#4A5550]">No paid orders in this period.</p> : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-left text-sm">
                  <thead className="text-xs uppercase tracking-wide text-[#4A5550]"><tr><th className="py-2">Rate</th><th className="py-2 text-right">Taxable value</th><th className="py-2 text-right">CGST</th><th className="py-2 text-right">SGST</th><th className="py-2 text-right">IGST</th><th className="py-2 text-right">Total GST</th></tr></thead>
                  <tbody className="divide-y divide-[#E6EAE7] tabular-nums">
                    {data.gst.byRate.map((r) => (
                      <tr key={r.rateBps}><td className="py-2">{r.rateBps / 100}%</td><td className="py-2 text-right">{formatPaise(r.taxableValueMinor)}</td><td className="py-2 text-right">{formatPaise(r.cgstMinor)}</td><td className="py-2 text-right">{formatPaise(r.sgstMinor)}</td><td className="py-2 text-right">{formatPaise(r.igstMinor)}</td><td className="py-2 text-right font-semibold">{formatPaise(r.totalGstMinor)}</td></tr>
                    ))}
                  </tbody>
                  <tfoot className="border-t border-[#DCE3DE] font-semibold tabular-nums"><tr><td className="py-2">Total</td><td className="py-2 text-right">{formatPaise(data.gst.totals.taxableValueMinor)}</td><td className="py-2 text-right">{formatPaise(data.gst.totals.cgstMinor)}</td><td className="py-2 text-right">{formatPaise(data.gst.totals.sgstMinor)}</td><td className="py-2 text-right">{formatPaise(data.gst.totals.igstMinor)}</td><td className="py-2 text-right">{formatPaise(data.gst.totals.totalGstMinor)}</td></tr></tfoot>
                </table>
              </div>
            )}
            <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-[#4A5550]">{data.gst.notes.map((n) => <li key={n}>{n}</li>)}</ul>
          </section>
        </div>
      )}
    </AdminPage>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className={`${adminCard} p-4`}>
      <p className="text-xs text-[#4A5550]">{label}</p>
      <p className="mt-1 break-words text-2xl font-semibold text-[#113322]">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-[#4A5550]">{hint}</p>}
    </div>
  );
}

/**
 * Revenue per day. One series, so no legend: the title names it. Bars are capped at 24px with a 4px rounded top,
 * grow from one baseline and are separated by a gap, not a border. Every value is in the tooltip (hover or focus)
 * and in the table view.
 */
function SalesChart({ days }: { days: SalesByDay['days'] }) {
  const [active, setActive] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const max = days.reduce((m, d) => Math.max(m, d.grossMinor), 0);
  const ticks = axisTicks(max);
  const top = ticks.at(-1) ?? 1;
  const compact = top >= 10_000 * 100;
  const peak = max > 0 ? days.reduce((best, d, i) => (d.grossMinor > days[best]!.grossMinor ? i : best), 0) : -1;
  const labelAt = new Set([0, Math.round((days.length - 1) / 4), Math.round((days.length - 1) / 2), Math.round(((days.length - 1) * 3) / 4), days.length - 1]);
  const focusable = days.length <= 45;
  const hovered = active === null ? null : days[active];

  return (
    <section className={`${adminCard} min-w-0 p-5`} aria-label="Revenue by day">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-heading text-lg font-bold">Revenue by day</h2>
          <p className="text-sm text-[#4A5550]">{peak >= 0 ? `Best day: ${dayLabel(days[peak]!.date)}, ${formatPaise(days[peak]!.grossMinor)}` : 'No paid orders in this period.'}</p>
        </div>
        <button type="button" className={adminGhostButton} aria-pressed={table} onClick={() => setTable((t) => !t)}>{table ? 'Show chart' : 'Show as table'}</button>
      </div>

      {table ? (
        <div className="max-h-80 overflow-auto rounded-xl border border-[#E6EAE7]">
          <table className="w-full text-left text-sm tabular-nums">
            <thead className="sticky top-0 bg-[#F7F9F8] text-xs uppercase tracking-wide text-[#4A5550]"><tr><th className="p-3">Day</th><th className="p-3 text-right">Paid orders</th><th className="p-3 text-right">Revenue</th></tr></thead>
            <tbody className="divide-y divide-[#E6EAE7]">{days.map((d) => <tr key={d.date}><td className="p-3">{formatIndianDate(`${d.date}T00:00:00+05:30`)}</td><td className="p-3 text-right">{d.paidOrders}</td><td className="p-3 text-right">{formatPaise(d.grossMinor)}</td></tr>)}</tbody>
          </table>
        </div>
      ) : (
        <div className="flex gap-2">
          <div className="relative h-56 w-12 shrink-0 text-right text-[11px] text-[#4A5550]" aria-hidden="true">
            {ticks.map((t) => <span key={t} className="absolute right-0 -translate-y-1/2 tabular-nums" style={{ bottom: `${(t / top) * 100}%` }}>{formatAxisMoney(t, compact)}</span>)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="relative h-56">
              {ticks.map((t) => <div key={t} className="absolute inset-x-0 border-t border-[#E6EAE7]" style={{ bottom: `${(t / top) * 100}%` }} aria-hidden="true" />)}
              <div className={`absolute inset-0 flex items-end ${days.length > 90 ? 'gap-px' : 'gap-0.5'}`} onPointerLeave={() => setActive(null)}>
                {days.map((d, i) => (
                  <button
                    type="button"
                    key={d.date}
                    tabIndex={focusable ? 0 : -1}
                    aria-label={`${dayLabel(d.date)}: ${formatPaise(d.grossMinor)} from ${d.paidOrders} paid order${d.paidOrders === 1 ? '' : 's'}`}
                    className="group relative flex h-full min-w-0 flex-1 items-end justify-center outline-none"
                    onPointerEnter={() => setActive(i)}
                    onFocus={() => setActive(i)}
                    onBlur={() => setActive(null)}
                  >
                    <span
                      className={`block w-full max-w-6 rounded-t-[4px] transition-colors ${active === i ? 'bg-[#0b4a31] ring-2 ring-[#116644]/30' : 'bg-[#116644]'}`}
                      style={{ height: `${(d.grossMinor / top) * 100}%`, minHeight: d.grossMinor > 0 ? 2 : 0 }}
                    />
                  </button>
                ))}
              </div>
              {hovered && active !== null && (
                <div
                  role="status"
                  className="pointer-events-none absolute z-10 w-44 -translate-x-1/2 rounded-xl border border-[#E6EAE7] bg-white p-3 text-xs shadow-lg"
                  style={{ left: `${Math.min(88, Math.max(12, ((active + 0.5) / days.length) * 100))}%`, bottom: `${Math.min(80, (hovered.grossMinor / top) * 100 + 4)}%` }}
                >
                  <p className="flex items-center gap-2 text-base font-semibold text-[#113322]"><span className="inline-block h-0.5 w-3 rounded bg-[#116644]" aria-hidden="true" />{formatPaise(hovered.grossMinor)}</p>
                  <p className="mt-0.5 text-[#4A5550]">{formatIndianDate(`${hovered.date}T00:00:00+05:30`)}</p>
                  <p className="text-[#4A5550]">{hovered.paidOrders} paid order{hovered.paidOrders === 1 ? '' : 's'}</p>
                </div>
              )}
            </div>
            <div className={`mt-2 flex text-[11px] text-[#4A5550] ${days.length > 90 ? 'gap-px' : 'gap-0.5'}`} aria-hidden="true">
              {days.map((d, i) => (
                <span key={d.date} className="relative h-4 min-w-0 flex-1">
                  {labelAt.has(i) && <span className={`absolute top-0 whitespace-nowrap ${i === 0 ? 'left-0' : i === days.length - 1 ? 'right-0' : 'left-1/2 -translate-x-1/2'}`}>{dayLabel(d.date)}</span>}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
