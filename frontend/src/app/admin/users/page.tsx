'use client';

import { useState } from 'react';
import { Search } from 'lucide-react';
import { useAdminSession } from '@/components/AdminAccess';
import { Alert, AdminPage, DataState, Field, Pager, Pill, adminButton, adminCard, adminDangerButton, adminGhostButton, adminInput } from '@/components/AdminKit';
import { adminDelete, adminGet, adminList, adminPatch, adminPost } from '@/lib/admin-api';
import { useAdminQuery } from '@/lib/useAdminQuery';
import { formatDateTime } from '@/lib/formatters';

type UserStatus = 'PENDING_VERIFICATION' | 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';
interface UserRow {
  id: string;
  email: string;
  name: string | null;
  status: UserStatus;
  mfaEnabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  roles: string[];
}
interface RoleInfo {
  name: string;
  description: string | null;
  rank: number;
  permissions: string[];
}

const STATUS_TONE = { ACTIVE: 'green', PENDING_VERIFICATION: 'amber', SUSPENDED: 'red', DEACTIVATED: 'gray' } as const;
const STATUS_LABEL: Record<UserStatus, string> = { ACTIVE: 'Active', PENDING_VERIFICATION: 'Email not verified', SUSPENDED: 'Suspended', DEACTIVATED: 'Deactivated' };
const roleLabel = (r: string) => r.toLowerCase().replaceAll('_', ' ');
const errorText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong. Please try again.');

export default function AdminUsersPage() {
  const { identity, withStepUp } = useAdminSession();
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [role, setRole] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [suspending, setSuspending] = useState<{ id: string; reason: string } | null>(null);
  const [granting, setGranting] = useState<{ id: string; role: string } | null>(null);
  const [showRoles, setShowRoles] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const roles = useAdminQuery(() => adminGet<RoleInfo[]>('/admin/roles'), []);
  const list = useAdminQuery(() => adminList<UserRow>('/admin/users', { q, role, status, page, pageSize: 20 }), [q, role, status, page]);
  const rows = list.data?.items ?? [];

  async function act(id: string, message: string, call: () => Promise<unknown>) {
    setBusyId(id);
    setError('');
    setNotice('');
    try {
      await withStepUp(call);
      setNotice(message);
      setSuspending(null);
      setGranting(null);
      list.reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <AdminPage eyebrow="Access" title="Users & roles" subtitle="Give people the access they need and no more. The server decides who may change whom; every change is recorded.">
      {error && <Alert kind="error">{error}</Alert>}
      {notice && <Alert kind="success">{notice}</Alert>}

      <section className={`${adminCard} min-w-0`}>
        <form
          className="flex flex-wrap gap-3 border-b border-[#E6EAE7] p-4"
          onSubmit={(e) => {
            e.preventDefault();
            setPage(1);
            setQ(search.trim());
          }}
        >
          <label className="relative min-w-[200px] flex-1">
            <span className="sr-only">Search by name or email</span>
            <Search className="absolute left-3 top-3 h-4 w-4 text-[#4A5550]" />
            <input className={`${adminInput} pl-9`} placeholder="Name or email" maxLength={100} value={search} onChange={(e) => setSearch(e.target.value)} />
          </label>
          <select aria-label="Filter by role" className="rounded-xl border border-[#DCE3DE] bg-white p-2 text-sm" value={role} onChange={(e) => { setPage(1); setRole(e.target.value); }}>
            <option value="">All roles</option>
            {(roles.data ?? []).map((r) => <option key={r.name} value={r.name}>{roleLabel(r.name)}</option>)}
          </select>
          <select aria-label="Filter by status" className="rounded-xl border border-[#DCE3DE] bg-white p-2 text-sm" value={status} onChange={(e) => { setPage(1); setStatus(e.target.value); }}>
            <option value="">Any status</option>
            <option value="ACTIVE">Active</option>
            <option value="PENDING_VERIFICATION">Email not verified</option>
            <option value="SUSPENDED">Suspended</option>
          </select>
          <button className={adminGhostButton}>Search</button>
        </form>

        <DataState loading={list.loading && !list.data} error={list.error} empty={rows.length === 0} emptyTitle="No matching accounts" emptyHint="Try another name, email, role or status.">
          <ul className="divide-y divide-[#E6EAE7]">
            {rows.map((u) => {
              const self = u.id === identity.id;
              const isStaff = u.roles.some((r) => r !== 'CUSTOMER');
              const available = (roles.data ?? []).filter((r) => !u.roles.includes(r.name));
              return (
                <li key={u.id} className="space-y-3 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="break-all font-semibold">{u.email}{self && <span className="ml-2 text-xs font-normal text-[#4A5550]">(you)</span>}</p>
                      <p className="text-sm text-[#4A5550]">{u.name ?? 'No customer profile'} · joined {formatDateTime(u.createdAt)}{u.lastLoginAt ? ` · last sign-in ${formatDateTime(u.lastLoginAt)}` : ''}</p>
                      <p className="mt-2 flex flex-wrap items-center gap-2">
                        {u.roles.map((r) => (
                          <span key={r} className="inline-flex items-center gap-1 rounded-full bg-[#EEFFEE] px-2.5 py-1 text-[11px] font-semibold text-[#116644]">
                            {roleLabel(r)}
                            {r !== 'CUSTOMER' && !self && (
                              <button
                                type="button"
                                aria-label={`Remove ${roleLabel(r)} role from ${u.email}`}
                                disabled={busyId === u.id}
                                className="ml-0.5 rounded-full px-1 text-[#116644] hover:bg-white"
                                onClick={() => { if (window.confirm(`Remove the ${roleLabel(r)} role from ${u.email}? Their sessions end immediately.`)) void act(u.id, `${roleLabel(r)} role removed.`, () => adminDelete(`/admin/users/${u.id}/roles/${r}`)); }}
                              >
                                ×
                              </button>
                            )}
                          </span>
                        ))}
                        {isStaff && !u.mfaEnabled && <Pill tone="red">No two-step verification</Pill>}
                      </p>
                    </div>
                    <Pill tone={STATUS_TONE[u.status]}>{STATUS_LABEL[u.status]}</Pill>
                  </div>

                  {!self && (
                    granting?.id === u.id ? (
                      <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void act(u.id, `${roleLabel(granting.role)} role given to ${u.email}.`, () => adminPost(`/admin/users/${u.id}/roles`, { role: granting.role })); }}>
                        <Field label="Role to give">
                          <select required className={adminInput} value={granting.role} onChange={(e) => setGranting({ id: u.id, role: e.target.value })}>
                            <option value="">Choose a role…</option>
                            {available.map((r) => <option key={r.name} value={r.name}>{roleLabel(r.name)}</option>)}
                          </select>
                        </Field>
                        <button className={adminButton} disabled={busyId === u.id || !granting.role}>Give role</button>
                        <button type="button" className={adminGhostButton} onClick={() => setGranting(null)}>Cancel</button>
                      </form>
                    ) : suspending?.id === u.id ? (
                      <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void act(u.id, `${u.email} suspended. Their sessions have ended.`, () => adminPatch(`/admin/users/${u.id}/status`, { status: 'SUSPENDED', reason: suspending.reason.trim() })); }}>
                        <Field label="Reason for suspending">
                          <input required minLength={3} maxLength={300} className={adminInput} value={suspending.reason} onChange={(e) => setSuspending({ id: u.id, reason: e.target.value })} />
                        </Field>
                        <button className={adminDangerButton} disabled={busyId === u.id}>Suspend account</button>
                        <button type="button" className={adminGhostButton} onClick={() => setSuspending(null)}>Cancel</button>
                      </form>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        <button className={adminGhostButton} disabled={available.length === 0 || busyId === u.id} onClick={() => setGranting({ id: u.id, role: '' })}>Give a role…</button>
                        {u.status === 'SUSPENDED' ? (
                          <button className={adminButton} disabled={busyId === u.id} onClick={() => void act(u.id, `${u.email} restored.`, () => adminPatch(`/admin/users/${u.id}/status`, { status: 'ACTIVE' }))}>Restore account</button>
                        ) : u.status === 'ACTIVE' ? (
                          <button className={adminGhostButton} disabled={busyId === u.id} onClick={() => setSuspending({ id: u.id, reason: '' })}>Suspend…</button>
                        ) : null}
                      </div>
                    )
                  )}
                </li>
              );
            })}
          </ul>
          {list.data && <Pager meta={list.data.meta} onPage={setPage} />}
        </DataState>
      </section>

      <section className={`${adminCard} p-5`}>
        <button type="button" className="font-heading text-lg font-bold" aria-expanded={showRoles} onClick={() => setShowRoles((s) => !s)}>
          What each role can do {showRoles ? '▴' : '▾'}
        </button>
        {showRoles && (
          roles.error ? <div className="mt-3"><Alert kind="error">{roles.error}</Alert></div> : (
            <ul className="mt-4 space-y-4 text-sm">
              {(roles.data ?? []).map((r) => (
                <li key={r.name}>
                  <p className="font-semibold">{roleLabel(r.name)}</p>
                  {r.description && <p className="text-[#4A5550]">{r.description}</p>}
                  <p className="mt-1 break-words text-xs text-[#4A5550]">{r.permissions.length ? r.permissions.join(', ') : 'No admin permissions'}</p>
                </li>
              ))}
            </ul>
          )
        )}
      </section>
    </AdminPage>
  );
}
