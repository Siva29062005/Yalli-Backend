'use client';

import { useState } from 'react';
import { AlertTriangle, Search } from 'lucide-react';
import { useAdminSession } from '@/components/AdminContext';
import { Alert, AdminPage, DataState, Field, Pager, Pill, adminButton, adminCard, adminGhostButton, adminInput, useClampedPage } from '@/components/AdminKit';
import { adminGet, adminList, adminPatch, adminPost } from '@/lib/admin-api';
import { useAdminQuery } from '@/lib/useAdminQuery';
import { formatIndianDate } from '@/lib/formatters';

interface InventoryRow {
  sku: string;
  product: string;
  warehouse: string;
  onHand: number;
  reserved: number;
  available: number;
  lowStockThreshold: number;
}
interface Warehouse {
  code: string;
  name: string;
  isDefault: boolean;
  isActive: boolean;
}
interface Movement {
  type: string;
  onHandDelta: number;
  reservedDelta: number;
  onHandAfter: number;
  reservedAfter: number;
  reason: string | null;
  referenceType: string | null;
  createdAt: string;
}

const MOVEMENT_LABEL: Record<string, string> = {
  RECEIPT: 'Stock received',
  ADJUSTMENT: 'Correction',
  RETURN: 'Customer return',
  RESERVE: 'Reserved for order',
  RELEASE: 'Reservation released',
  COMMIT: 'Sold',
  EXPIRE: 'Reservation expired',
};
const warehouseLabel = (list: Warehouse[], code: string) => {
  const w = list.find((x) => x.code === code);
  return w ? `${w.name} (${code})` : code;
};
const signed = (n: number) => (n > 0 ? `+${n}` : String(n));
const errorText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong. Please try again.');

export default function AdminInventoryPage() {
  const { withStepUp, can } = useAdminSession();
  const [search, setSearch] = useState('');
  const [sku, setSku] = useState('');
  const [lowOnly, setLowOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [adjusting, setAdjusting] = useState<{ sku: string; warehouse?: string } | null>(null);
  const [history, setHistory] = useState<string | null>(null);
  const [levelFor, setLevelFor] = useState<{ sku: string; warehouse: string; value: string } | null>(null);
  const [rowError, setRowError] = useState('');

  async function saveLevel() {
    if (!levelFor) return;
    if (!/^\d{1,6}$/.test(levelFor.value.trim()) || Number(levelFor.value) > 100000) return setRowError('Enter a whole number from 0 to 100,000.');
    setRowError('');
    try {
      await withStepUp(() => adminPatch('/admin/inventory/threshold', { sku: levelFor.sku, warehouseCode: levelFor.warehouse, lowStockThreshold: Number(levelFor.value) }));
      setNotice(`${levelFor.sku}: low-stock level is now ${Number(levelFor.value)}.`);
      setLevelFor(null);
      list.reload();
    } catch (e) {
      setRowError(errorText(e));
    }
  }
  const [notice, setNotice] = useState('');

  const list = useAdminQuery(
    () => adminList<InventoryRow>('/admin/inventory', { sku, lowStock: lowOnly ? 'true' : undefined, page, pageSize: 20 }),
    [sku, lowOnly, page],
  );
  const warehouses = useAdminQuery(() => adminGet<Warehouse[]>('/admin/warehouses'), []);
  useClampedPage(list.data?.meta, page, setPage);
  const rows = list.data?.items ?? [];
  const lowCount = rows.filter((r) => r.available <= r.lowStockThreshold).length;

  return (
    <AdminPage eyebrow="Operations" title="Inventory" subtitle="See what is on the shelf and keep every change on the record. Each adjustment needs a reason.">
      {notice && <Alert kind="success">{notice}</Alert>}
      {rowError && <Alert kind="error">{rowError}</Alert>}
      {lowCount > 0 && !lowOnly && (
        <Alert kind="warning">
          <AlertTriangle className="mr-2 inline h-4 w-4" />
          {lowCount} item{lowCount === 1 ? '' : 's'} on this page {lowCount === 1 ? 'is' : 'are'} at or below the low-stock level.
        </Alert>
      )}

      <section className={`${adminCard} min-w-0`}>
        <form
          className="flex flex-wrap items-center gap-3 border-b border-[#E6EAE7] p-4"
          onSubmit={(e) => {
            e.preventDefault();
            setPage(1);
            setSku(search.trim());
          }}
        >
          <label className="relative min-w-[220px] flex-1">
            <span className="sr-only">Search by SKU</span>
            <Search className="absolute left-3 top-3 h-4 w-4 text-[#4A5550]" />
            <input className={`${adminInput} pl-9`} placeholder="Search by SKU" maxLength={64} value={search} onChange={(e) => setSearch(e.target.value)} />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={lowOnly}
              onChange={(e) => {
                setPage(1);
                setLowOnly(e.target.checked);
              }}
            />
            Low stock only
          </label>
          <button className={adminGhostButton}>Search</button>
          {can('inventory.adjust') && <button type="button" className={adminButton} onClick={() => setAdjusting({ sku: '' })}>Adjust stock</button>}
        </form>

        <DataState loading={list.loading && !list.data} error={list.error} empty={rows.length === 0} emptyTitle="No stock records found" emptyHint={sku || lowOnly ? 'Try another SKU or clear the low-stock filter.' : 'Stock appears here once a variant has received stock.'}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="bg-[#F7F9F8] text-xs uppercase tracking-wide text-[#4A5550]">
                <tr>
                  <th className="p-4">SKU</th>
                  <th className="p-4">Product</th>
                  <th className="p-4">Warehouse</th>
                  <th className="p-4 text-right">On hand</th>
                  <th className="p-4 text-right">Reserved</th>
                  <th className="p-4 text-right">Available</th>
                  <th className="p-4">Status</th>
                  <th className="p-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E6EAE7]">
                {rows.map((r) => {
                  const low = r.available <= r.lowStockThreshold;
                  return (
                    <tr key={`${r.sku}:${r.warehouse}`}>
                      <td className="break-all p-4 font-semibold">{r.sku}</td>
                      <td className="p-4">{r.product}</td>
                      <td className="p-4">{r.warehouse}</td>
                      <td className="p-4 text-right">{r.onHand}</td>
                      <td className="p-4 text-right">{r.reserved}</td>
                      <td className="p-4 text-right font-semibold">{r.available}</td>
                      <td className="p-4">
                        {r.available <= 0 ? <Pill tone="red">Out of stock</Pill> : low ? <Pill tone="amber">Low</Pill> : <Pill tone="green">In stock</Pill>}
                        {levelFor?.sku === r.sku && levelFor.warehouse === r.warehouse ? (
                          <form className="mt-2 flex items-center gap-1" onSubmit={(e) => { e.preventDefault(); void saveLevel(); }}>
                            <input aria-label={`Low-stock level for ${r.sku}`} inputMode="numeric" autoFocus className={`${adminInput} w-20 py-1`} value={levelFor.value} onChange={(e) => setLevelFor({ ...levelFor, value: e.target.value })} />
                            <button className="text-xs font-semibold text-[#116644]">Save</button>
                            <button type="button" className="text-xs text-[#4A5550]" onClick={() => { setLevelFor(null); setRowError(''); }}>Cancel</button>
                          </form>
                        ) : (
                          <span className="mt-1 block text-xs text-[#4A5550]">
                            low at {r.lowStockThreshold}
                            {can('inventory.adjust') && (
                              <button type="button" className="ml-1 font-semibold text-[#116644] underline" aria-label={`Change low-stock level for ${r.sku}`} onClick={() => { setRowError(''); setLevelFor({ sku: r.sku, warehouse: r.warehouse, value: String(r.lowStockThreshold) }); }}>
                                change
                              </button>
                            )}
                          </span>
                        )}
                      </td>
                      <td className="p-4">
                        <div className="flex justify-end gap-2">
                          <button className={adminGhostButton} onClick={() => setHistory(r.sku)}>History</button>
                          {can('inventory.adjust') && <button className={adminButton} onClick={() => setAdjusting({ sku: r.sku, warehouse: r.warehouse })}>Adjust</button>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {list.data && <Pager meta={list.data.meta} onPage={setPage} />}
        </DataState>
      </section>

      {adjusting && (
        <AdjustDialog
          initialSku={adjusting.sku}
          fixedWarehouse={adjusting.warehouse}
          warehouses={(warehouses.data ?? []).filter((w) => w.isActive)}
          run={withStepUp}
          onClose={() => setAdjusting(null)}
          onDone={(message) => {
            setAdjusting(null);
            setNotice(message);
            list.reload();
          }}
        />
      )}
      {can('inventory.adjust') && <WarehousesPanel warehouses={warehouses.data ?? []} run={withStepUp} onChanged={() => { warehouses.reload(); list.reload(); }} />}
      {/* keyed by SKU: another SKU's history starts on its first page */}
      {history && <HistoryPanel key={history} sku={history} onClose={() => setHistory(null)} />}
    </AdminPage>
  );
}

function AdjustDialog({
  initialSku,
  fixedWarehouse,
  warehouses,
  run,
  onClose,
  onDone,
}: {
  initialSku: string;
  /** Opened from a stock row: the change applies to THAT row's warehouse. */
  fixedWarehouse?: string;
  warehouses: Warehouse[];
  run: <T>(call: () => Promise<T>) => Promise<T>;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [sku, setSku] = useState(initialSku);
  const [warehouse, setWarehouse] = useState(fixedWarehouse ?? '');
  const [direction, setDirection] = useState<'add' | 'remove'>('add');
  const [quantity, setQuantity] = useState('');
  const [type, setType] = useState<'RECEIPT' | 'ADJUSTMENT' | 'RETURN'>('RECEIPT');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!/^\d{1,6}$/.test(quantity) || Number(quantity) < 1 || Number(quantity) > 100000) return setError('Enter a whole quantity between 1 and 100,000.');
    const delta = direction === 'add' ? Number(quantity) : -Number(quantity);
    setBusy(true);
    setError('');
    try {
      const result = await run(() =>
        adminPost<{ sku: string; onHand: number }>('/admin/inventory/adjustments', {
          sku: sku.trim(),
          ...(warehouse ? { warehouseCode: warehouse } : {}),
          delta,
          type,
          reason: reason.trim(),
        }),
      );
      onDone(`${result.sku}: stock is now ${result.onHand} on hand.`);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center overflow-y-auto bg-black/40 p-4">
      <form role="dialog" aria-modal="true" aria-labelledby="adjust-title" onSubmit={submit} className="w-full max-w-md space-y-4 rounded-2xl bg-white p-6 shadow-xl">
        <h2 id="adjust-title" className="text-lg font-bold">Adjust stock</h2>
        {error && <Alert kind="error">{error}</Alert>}
        <Field label="SKU">
          <input required autoFocus={!initialSku} readOnly={!!initialSku} maxLength={64} className={adminInput} value={sku} onChange={(e) => setSku(e.target.value)} />
        </Field>
        {fixedWarehouse ? (
          <Field label="Warehouse">
            <input readOnly className={adminInput} value={warehouseLabel(warehouses, fixedWarehouse)} />
          </Field>
        ) : warehouses.length > 1 && (
          <Field label="Warehouse">
            <select className={adminInput} value={warehouse} onChange={(e) => setWarehouse(e.target.value)}>
              <option value="">Default warehouse</option>
              {warehouses.map((w) => <option key={w.code} value={w.code}>{w.name} ({w.code})</option>)}
            </select>
          </Field>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Change">
            <select className={adminInput} value={direction} onChange={(e) => setDirection(e.target.value as 'add' | 'remove')}>
              <option value="add">Add to stock</option>
              <option value="remove">Remove from stock</option>
            </select>
          </Field>
          <Field label="Quantity">
            <input required inputMode="numeric" className={adminInput} value={quantity} onChange={(e) => setQuantity(e.target.value)} />
          </Field>
        </div>
        <Field label="Kind of change">
          <select className={adminInput} value={type} onChange={(e) => setType(e.target.value as typeof type)}>
            <option value="RECEIPT">New stock received</option>
            <option value="RETURN">Customer return put back</option>
            <option value="ADJUSTMENT">Count correction / damage / loss</option>
          </select>
        </Field>
        <Field label="Reason" hint="Kept in the audit trail. 3 to 200 characters.">
          <input required minLength={3} maxLength={200} className={adminInput} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-3">
          <button type="button" className={adminGhostButton} disabled={busy} onClick={onClose}>Cancel</button>
          <button className={adminButton} disabled={busy}>{busy ? 'Saving…' : 'Save adjustment'}</button>
        </div>
      </form>
    </div>
  );
}

function HistoryPanel({ sku, onClose }: { sku: string; onClose: () => void }) {
  const [page, setPage] = useState(1);
  const movements = useAdminQuery(() => adminList<Movement>('/admin/inventory/movements', { sku, page, pageSize: 15 }), [sku, page]);
  useClampedPage(movements.data?.meta, page, setPage);
  const rows = movements.data?.items ?? [];
  return (
    <section className={`${adminCard} min-w-0`} aria-label={`Stock history for ${sku}`}>
      <div className="flex items-center justify-between gap-3 p-4">
        <h2 className="break-all font-heading text-lg font-bold">Stock history · {sku}</h2>
        <button className={adminGhostButton} onClick={onClose}>Close</button>
      </div>
      <DataState loading={movements.loading && !movements.data} error={movements.error} empty={rows.length === 0} emptyTitle="No movements recorded">
        <div className="overflow-x-auto border-t border-[#E6EAE7]">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="bg-[#F7F9F8] text-xs uppercase tracking-wide text-[#4A5550]">
              <tr><th className="p-3">When</th><th className="p-3">What</th><th className="p-3 text-right">On hand</th><th className="p-3 text-right">Reserved</th><th className="p-3">Reason</th></tr>
            </thead>
            <tbody className="divide-y divide-[#E6EAE7]">
              {rows.map((m, i) => (
                <tr key={i}>
                  <td className="whitespace-nowrap p-3">{formatIndianDate(m.createdAt)}</td>
                  <td className="p-3">{MOVEMENT_LABEL[m.type] ?? m.type}</td>
                  <td className="p-3 text-right">{m.onHandDelta !== 0 ? `${signed(m.onHandDelta)} → ${m.onHandAfter}` : m.onHandAfter}</td>
                  <td className="p-3 text-right">{m.reservedDelta !== 0 ? `${signed(m.reservedDelta)} → ${m.reservedAfter}` : m.reservedAfter}</td>
                  <td className="break-words p-3">{m.reason ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {movements.data && <Pager meta={movements.data.meta} onPage={setPage} />}
      </DataState>
    </section>
  );
}

/** Warehouses: add one, rename, switch on/off, choose the default (where new stock is received). */
function WarehousesPanel({ warehouses, run, onChanged }: { warehouses: Warehouse[]; run: <T>(call: () => Promise<T>) => Promise<T>; onChanged: () => void }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [renaming, setRenaming] = useState<{ code: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function act(message: string, call: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await run(call);
      setNotice(message);
      onChanged();
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={`${adminCard} min-w-0 space-y-4 p-5`} aria-label="Warehouses">
      <h2 className="font-heading text-lg font-bold">Warehouses</h2>
      {error && <Alert kind="error">{error}</Alert>}
      {notice && <Alert kind="success">{notice}</Alert>}
      <ul className="divide-y divide-[#E6EAE7] rounded-xl border border-[#E6EAE7] text-sm">
        {warehouses.map((w) => (
          <li key={w.code} className="flex flex-wrap items-center justify-between gap-3 p-3">
            {renaming?.code === w.code ? (
              <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); void act('Warehouse renamed.', () => adminPatch(`/admin/warehouses/${w.code}`, { name: renaming.name.trim() })).then((ok) => ok && setRenaming(null)); }}>
                <input aria-label={`New name for ${w.code}`} required minLength={2} maxLength={100} className={`${adminInput} max-w-xs py-1.5`} value={renaming.name} onChange={(e) => setRenaming({ code: w.code, name: e.target.value })} />
                <button className="text-xs font-semibold text-[#116644]" disabled={busy}>Save</button>
                <button type="button" className="text-xs text-[#4A5550]" onClick={() => setRenaming(null)}>Cancel</button>
              </form>
            ) : (
              <span className="min-w-0 break-words">
                <strong>{w.name}</strong> <span className="text-[#4A5550]">({w.code})</span>{' '}
                {w.isDefault && <Pill tone="green">Default</Pill>} {!w.isActive && <Pill tone="gray">Switched off</Pill>}
              </span>
            )}
            <span className="flex flex-wrap gap-2">
              <button type="button" className={adminGhostButton} disabled={busy} onClick={() => setRenaming({ code: w.code, name: w.name })}>Rename</button>
              {!w.isDefault && w.isActive && (
                <button type="button" className={adminGhostButton} disabled={busy} onClick={() => { if (window.confirm(`Make ${w.name} the default? New stock is received there and orders take stock from it first.`)) void act(`${w.name} is now the default warehouse.`, () => adminPatch(`/admin/warehouses/${w.code}`, { isDefault: true })); }}>Make default</button>
              )}
              {!w.isDefault && (
                <button type="button" className={adminGhostButton} disabled={busy} onClick={() => void act(w.isActive ? `${w.name} switched off.` : `${w.name} switched on.`, () => adminPatch(`/admin/warehouses/${w.code}`, { isActive: !w.isActive }))}>
                  {w.isActive ? 'Switch off' : 'Switch on'}
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
      <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); void act(`Warehouse ${code.trim().toUpperCase()} added.`, () => adminPost('/admin/warehouses', { code: code.trim(), name: name.trim() })).then((ok) => { if (ok) { setCode(''); setName(''); } }); }}>
        <Field label="Code" hint="2 to 20 letters, digits or dashes, e.g. CHN-1.">
          <input required minLength={2} maxLength={20} pattern="[A-Za-z0-9][A-Za-z0-9-]{1,19}" className={`${adminInput} uppercase`} value={code} onChange={(e) => setCode(e.target.value)} />
        </Field>
        <Field label="Warehouse name">
          <input required minLength={2} maxLength={100} className={adminInput} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <button className={adminButton} disabled={busy}>Add warehouse</button>
      </form>
      <p className="text-xs text-[#4A5550]">A warehouse that still holds stock or reservations cannot be switched off: move its stock first with “Adjust stock”.</p>
    </section>
  );
}
