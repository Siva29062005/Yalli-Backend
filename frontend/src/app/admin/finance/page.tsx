'use client';

import { useState } from 'react';
import { Download } from 'lucide-react';
import { useAdminSession } from '@/components/AdminContext';
import { Alert, AdminPage, DataState, Field, Pager, adminButton, adminCard, adminGhostButton, adminInput, useClampedPage } from '@/components/AdminKit';
import type { CreditNote } from '@/lib/account-api';
import { adminDownload, adminGet, adminList } from '@/lib/admin-api';
import { currentIndianMonth, monthRange } from '@/lib/finance';
import { useAdminQuery } from '@/lib/useAdminQuery';
import { formatDateTime, formatPaise } from '@/lib/formatters';

interface CreditNoteRow {
  id: string;
  creditNoteNumber: string;
  issuedAt: string;
  invoiceNumber: string;
  totalMinor: number;
  taxableValueMinor: number;
  cgstMinor: number;
  sgstMinor: number;
  igstMinor: number;
  order: { orderNumber: string };
}

const errorText = (e: unknown) => (e instanceof Error && e.message ? e.message : 'Something went wrong. Please try again.');


/**
 * Finance (payments.read): the GST credit-note register for a month, reprints, and the two exports (GSTR-1 credit
 * notes; refund reconciliation against the Razorpay settlement report). Exports are audited by the server.
 */
export default function AdminFinancePage() {
  const { withStepUp } = useAdminSession();
  const [month, setMonth] = useState(currentIndianMonth);
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const range = monthRange(month);
  const list = useAdminQuery(
    () => (range ? adminList<CreditNoteRow>('/admin/credit-notes', { ...range, page, pageSize: 20 }) : Promise.resolve(null)),
    [month, page],
  );
  useClampedPage(list.data?.meta, page, setPage);
  const rows = list.data?.items ?? [];

  async function download(kind: 'gstr1' | 'refunds') {
    if (!range) return;
    setBusy(kind);
    setError('');
    try {
      await withStepUp(() =>
        kind === 'gstr1'
          ? adminDownload('/admin/credit-notes/export', range, `credit-notes-${month}.csv`)
          : adminDownload('/admin/refunds/export', range, `refunds-${month}.csv`),
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  async function reprint(id: string) {
    const w = window.open('', '_blank'); // inside the click (pop-up blockers), filled in when the note arrives
    if (!w) return setError('Allow pop-ups for this site to view the credit note.');
    w.document.write('<p style="font-family:sans-serif">Preparing the credit note…</p>');
    try {
      const cn = await withStepUp(() => adminGet<CreditNote>(`/admin/credit-notes/${id}`));
      const { creditNoteHtml } = await import('@/lib/invoice');
      w.document.open();
      w.document.write(creditNoteHtml(cn));
      w.document.close();
    } catch (e) {
      w.close();
      setError(errorText(e));
    }
  }

  return (
    <AdminPage eyebrow="Money" title="Finance" subtitle="GST credit notes for filing and the refund list for matching against Razorpay settlements. Every export is recorded.">
      {error && <Alert kind="error">{error}</Alert>}
      <section className={`${adminCard} flex flex-wrap items-end gap-3 p-4`}>
        <Field label="Month">
          <input
            type="month"
            className={adminInput}
            value={month}
            max={currentIndianMonth()}
            onChange={(e) => {
              setPage(1);
              setMonth(e.target.value);
            }}
          />
        </Field>
        <button type="button" className={`${adminButton} inline-flex items-center gap-2`} disabled={!range || busy !== null} onClick={() => void download('gstr1')}>
          <Download className="h-4 w-4" /> {busy === 'gstr1' ? 'Preparing…' : 'Credit notes CSV (GSTR-1)'}
        </button>
        <button type="button" className={`${adminGhostButton} inline-flex items-center gap-2`} disabled={!range || busy !== null} onClick={() => void download('refunds')}>
          <Download className="h-4 w-4" /> {busy === 'refunds' ? 'Preparing…' : 'Refund reconciliation CSV'}
        </button>
        <p className="w-full text-xs text-[#4A5550]">
          Months are India calendar months. The credit-note file has one row per note and GST rate; your accountant decides the GSTR-1 table (CDNUR or B2CS). Match the refund file against the settlement report in the Razorpay dashboard by the Razorpay refund id.
        </p>
      </section>

      <section className={`${adminCard} min-w-0`}>
        <h2 className="border-b border-[#E6EAE7] p-4 font-heading text-lg font-bold">Credit notes issued</h2>
        <DataState loading={list.loading && !list.data} error={list.error} empty={rows.length === 0} emptyTitle="No credit notes this month" emptyHint="A credit note is issued automatically for every processed refund of an invoiced order.">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="bg-[#F7F9F8] text-xs uppercase tracking-wide text-[#4A5550]">
                <tr>
                  <th className="p-3">Credit note</th>
                  <th className="p-3">Issued</th>
                  <th className="p-3">Order / invoice</th>
                  <th className="p-3 text-right">Taxable</th>
                  <th className="p-3 text-right">GST</th>
                  <th className="p-3 text-right">Total</th>
                  <th className="p-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E6EAE7]">
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="p-3 font-semibold">{r.creditNoteNumber}</td>
                    <td className="whitespace-nowrap p-3">{formatDateTime(r.issuedAt)}</td>
                    <td className="p-3">{r.order.orderNumber} · {r.invoiceNumber}</td>
                    <td className="p-3 text-right">{formatPaise(r.taxableValueMinor)}</td>
                    <td className="p-3 text-right">{formatPaise(r.cgstMinor + r.sgstMinor + r.igstMinor)}</td>
                    <td className="p-3 text-right font-semibold">{formatPaise(r.totalMinor)}</td>
                    <td className="p-3 text-right">
                      <button type="button" className="font-semibold text-[#116644] underline" onClick={() => void reprint(r.id)} aria-label={`View credit note ${r.creditNoteNumber}`}>
                        View
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {list.data && <Pager meta={list.data.meta} onPage={setPage} />}
        </DataState>
      </section>
    </AdminPage>
  );
}
