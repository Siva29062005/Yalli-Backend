'use client';

import { useState } from 'react';
import { AlertTriangle, Search } from 'lucide-react';
import { useAdminSession } from '@/components/AdminAccess';
import { Alert, AdminPage, DataState, Field, Pager, Pill, adminButton, adminCard, adminGhostButton, adminInput } from '@/components/AdminKit';
import { adminGet, adminList, adminPost } from '@/lib/admin-api';
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
const signed = (n: number) => (n > 0 ? `+${n}` : String(n));
const errorText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong. Please try again.');

export default function AdminInventoryPage() {
  const { withStepUp } = useAdminSession();
  const [search, setSearch] = useState('');
  const [sku, setSku] = useState('');
  const [lowOnly, setLowOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [adjusting, setAdjusting] = useState<{ sku: string } | null>(null);
  const [history, setHistory] = useState<string | null>(null);
  const [notice, setNotice] = useState('');

  const list = useAdminQuery(
    () => adminList<InventoryRow>('/admin/inventory', { sku, lowStock: lowOnly ? 'true' : undefined, page, pageSize: 20 }),
    [sku, lowOnly, page],
  );
  const warehouses = useAdminQuery(() => adminGet<Warehouse[]>('/admin/warehouses'), []);
  const rows = list.data?.items ?? [];
  const lowCount = rows.filter((r) => r.available <= r.lowStockThreshold).length;

  return (
    <AdminPage eyebrow="Operations" title="Inventory" subtitle="See what is on the shelf and keep every change on the record. Each adjustment needs a reason.">
      {notice && <Alert kind="success">{notice}</Alert>}
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
          <button type="button" className={adminButton} onClick={() => setAdjusting({ sku: '' })}>Adjust stock</button>
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
                      <td className="p-4">{r.available <= 0 ? <Pill tone="red">Out of stock</Pill> : low ? <Pill tone="amber">Low</Pill> : <Pill tone="green">In stock</Pill>}</td>
                      <td className="p-4">
                        <div className="flex justify-end gap-2">
                          <button className={adminGhostButton} onClick={() => setHistory(r.sku)}>History</button>
                          <button className={adminButton} onClick={() => setAdjusting({ sku: r.sku })}>Adjust</button>
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
      {history && <HistoryPanel sku={history} onClose={() => setHistory(null)} />}
    </AdminPage>
  );
}

function AdjustDialog({
  initialSku,
  warehouses,
  run,
  onClose,
  onDone,
}: {
  initialSku: string;
  warehouses: Warehouse[];
  run: <T>(call: () => Promise<T>) => Promise<T>;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [sku, setSku] = useState(initialSku);
  const [warehouse, setWarehouse] = useState('');
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
        {warehouses.length > 1 && (
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
