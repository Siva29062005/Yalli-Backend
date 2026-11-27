'use client';

import { useState } from 'react';
import { AdminPage, DataState, Field, Pager, Pill, adminCard, adminInput, useClampedPage } from '@/components/AdminKit';
import { adminGet, adminList } from '@/lib/admin-api';
import { useAdminQuery } from '@/lib/useAdminQuery';
import { formatDateTime } from '@/lib/formatters';

interface AuditRow {
  id: string;
  occurredAt: string;
  actorId: string | null;
  actorType: string;
  actorLabel: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  outcome: 'SUCCESS' | 'FAILURE' | 'DENIED';
  ip: string | null;
  correlationId: string | null;
  metadata: unknown;
}

const OUTCOME_TONE = { SUCCESS: 'green', FAILURE: 'amber', DENIED: 'red' } as const;

/** yyyy-mm-dd (an <input type="date">) -> the start of that India day as an ISO time, or undefined. */
const dayStart = (d: string) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T00:00:00+05:30` : undefined);
const dayEnd = (d: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return undefined;
  const next = new Date(`${d}T00:00:00+05:30`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString();
};

/**
 * Security (audit.read): who did what, when. Read-only; rows come from the server's read-only reporting connection.
 * Periods are capped at 92 days by the server (default: the last 7 days).
 */
export default function AdminAuditPage() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [category, setCategory] = useState('');
  const [action, setAction] = useState('');
  const [outcome, setOutcome] = useState('');
  const [actorId, setActorId] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const options = useAdminQuery(() => adminGet<{ actions: string[]; categories: string[] }>('/admin/audit-logs/actions'), []);
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const actor = UUID.test(actorId.trim()) ? actorId.trim() : undefined;
  const actorInvalid = actorId.trim() !== '' && !actor;
  const list = useAdminQuery(
    () =>
      adminList<AuditRow>('/admin/audit-logs', {
        from: dayStart(from),
        to: dayEnd(to),
        category: action ? undefined : category,
        action,
        outcome,
        actorId: actor,
        page,
        pageSize: 50,
      }),
    [from, to, category, action, outcome, actor, page],
  );
  useClampedPage(list.data?.meta, page, setPage);
  const rows = list.data?.items ?? [];
  // the period the server really searched (it cuts a longer one to the most recent 92 days)
  const raw = list.data?.rawMeta;
  const searched = typeof raw?.from === 'string' && typeof raw?.to === 'string' ? { from: raw.from, to: raw.to } : null;
  const requestedFrom = dayStart(from);
  const cut = !!searched && !!requestedFrom && new Date(searched.from).getTime() > new Date(requestedFrom).getTime();
  const reset = <T,>(set: (v: T) => void) => (v: T) => {
    setPage(1);
    set(v);
  };
  const actions = (options.data?.actions ?? []).filter((a) => !category || a.startsWith(`${category}.`));

  return (
    <AdminPage eyebrow="Security" title="Audit log" subtitle="Every sign-in, permission change, refund, price change and export is recorded here and cannot be edited.">
      <section className={`${adminCard} grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6`}>
        <Field label="From"><input type="date" className={adminInput} value={from} onChange={(e) => reset(setFrom)(e.target.value)} /></Field>
        <Field label="To"><input type="date" className={adminInput} value={to} onChange={(e) => reset(setTo)(e.target.value)} /></Field>
        <Field label="Area">
          <select className={adminInput} value={category} onChange={(e) => { reset(setCategory)(e.target.value); setAction(''); }}>
            <option value="">All areas</option>
            {(options.data?.categories ?? []).map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </Field>
        <Field label="Event">
          <select className={adminInput} value={action} onChange={(e) => reset(setAction)(e.target.value)}>
            <option value="">All events</option>
            {actions.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </Field>
        <Field label="Outcome">
          <select className={adminInput} value={outcome} onChange={(e) => reset(setOutcome)(e.target.value)}>
            <option value="">Any</option>
            <option value="SUCCESS">Success</option>
            <option value="FAILURE">Failure</option>
            <option value="DENIED">Denied</option>
          </select>
        </Field>
        <Field label="Person (user id)" hint="Paste an id from a row to see only that person.">
          <input className={adminInput} maxLength={36} aria-invalid={actorInvalid} value={actorId} onChange={(e) => reset(setActorId)(e.target.value)} />
        </Field>
        {actorInvalid && <p role="alert" className="text-xs text-red-700 sm:col-span-2">That is not a complete user id: the list is not filtered by person.</p>}
      </section>

      {searched && (
        <p className="text-sm text-[#4A5550]" role="status">
          Showing {formatDateTime(searched.from)} to {formatDateTime(searched.to)}.
          {cut && ' The server shows at most 92 days at a time: choose a later “From” date to see older events.'}
        </p>
      )}
      <section className={`${adminCard} min-w-0`}>
        <DataState loading={list.loading && !list.data} error={list.error} empty={rows.length === 0} emptyTitle="No events in this period" emptyHint="Widen the dates or clear a filter. Without dates, the last 7 days are shown.">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-left text-sm">
              <thead className="bg-[#F7F9F8] text-xs uppercase tracking-wide text-[#4A5550]">
                <tr>
                  <th className="p-3">When</th>
                  <th className="p-3">Event</th>
                  <th className="p-3">Outcome</th>
                  <th className="p-3">Who</th>
                  <th className="p-3">What</th>
                  <th className="p-3">IP</th>
                  <th className="p-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E6EAE7] align-top">
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="whitespace-nowrap p-3">{formatDateTime(r.occurredAt)}</td>
                    <td className="break-all p-3 font-mono text-xs">{r.action}</td>
                    <td className="p-3"><Pill tone={OUTCOME_TONE[r.outcome] ?? 'gray'}>{r.outcome.toLowerCase()}</Pill></td>
                    <td className="p-3">
                      <span className="block break-all">{r.actorLabel ?? (r.actorType === 'SYSTEM' ? 'System' : r.actorType.toLowerCase())}</span>
                      {r.actorId && (
                        <button type="button" className="text-xs text-[#116644] underline" onClick={() => reset(setActorId)(r.actorId!)}>
                          only this person
                        </button>
                      )}
                    </td>
                    <td className="break-all p-3 text-xs">{r.resourceType ? `${r.resourceType}${r.resourceId ? ` · ${r.resourceId}` : ''}` : '—'}</td>
                    <td className="whitespace-nowrap p-3 text-xs">{r.ip ?? '—'}</td>
                    <td className="p-3">
                      {r.metadata !== null && r.metadata !== undefined && (
                        <>
                          <button type="button" className="text-xs font-semibold text-[#116644]" aria-expanded={open === r.id} onClick={() => setOpen(open === r.id ? null : r.id)}>
                            {open === r.id ? 'Hide details' : 'Details'}
                          </button>
                          {/* rendered as text by React: never as markup */}
                          {open === r.id && <pre className="mt-2 max-w-md overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-[#F7F9F8] p-2 text-[11px]">{JSON.stringify(r.metadata, null, 2)}</pre>}
                        </>
                      )}
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
