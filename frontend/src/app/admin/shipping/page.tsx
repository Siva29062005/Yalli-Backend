'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { useAdminSession } from '@/components/AdminContext';
import { Alert, AdminPage, DataState, Field, Pill, adminButton, adminCard, adminGhostButton, adminInput } from '@/components/AdminKit';
import { adminGet, adminPatch, adminPost, paiseToRupees, rupeesToPaise } from '@/lib/admin-api';
import { useAdminQuery } from '@/lib/useAdminQuery';
import { INDIAN_STATES } from '@/lib/checkout-api';
import { formatPaise } from '@/lib/formatters';

interface ShippingMethod {
  id: string;
  code: string;
  name: string;
  description: string | null;
  baseMinor: number;
  freeAboveMinor: number | null;
  etaMinDays: number;
  etaMaxDays: number;
  states: string[];
  sortOrder: number;
  isActive: boolean;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong. Please try again.');
const eta = (m: ShippingMethod) => (m.etaMinDays === m.etaMaxDays ? `${m.etaMinDays} day${m.etaMinDays === 1 ? '' : 's'}` : `${m.etaMinDays}–${m.etaMaxDays} days`);

export default function AdminShippingPage() {
  const { withStepUp, can } = useAdminSession();
  // What delivery costs is a price: adding a method, its fee, "free above" and switching it on or off need
  // pricing.update (the server checks; this only hides what would be refused).
  const canPrice = can('pricing.update');
  const [editing, setEditing] = useState<'new' | ShippingMethod | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const list = useAdminQuery(() => adminGet<ShippingMethod[]>('/admin/shipping-methods'), []);
  const methods = list.data ?? [];
  const noneActive = list.data !== null && !methods.some((m) => m.isActive);

  async function toggle(m: ShippingMethod) {
    setBusyId(m.id);
    setError('');
    setNotice('');
    try {
      await withStepUp(() => adminPatch(`/admin/shipping-methods/${m.id}`, { isActive: !m.isActive }));
      setNotice(m.isActive ? `${m.name} turned off.` : `${m.name} turned on.`);
      list.reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <AdminPage
      eyebrow="Operations"
      title="Shipping methods"
      subtitle="Set what delivery costs and where it goes. The fee is always worked out on the server from the method the customer picks."
      actions={canPrice ? <button className={`${adminButton} inline-flex items-center gap-1.5`} onClick={() => setEditing('new')}><Plus className="h-4 w-4" /> Add method</button> : undefined}
    >
      {error && <Alert kind="error">{error}</Alert>}
      {notice && <Alert kind="success">{notice}</Alert>}
      {noneActive && !list.loading && !list.error && (
        <Alert kind="warning">No shipping method is turned on, so delivery is currently free for every order. Turn a method on to charge for delivery.</Alert>
      )}
      {editing && (
        <MethodForm
          key={editing === 'new' ? 'new' : editing.id}
          method={editing === 'new' ? null : editing}
          canPrice={canPrice}
          run={withStepUp}
          onClose={() => setEditing(null)}
          onSaved={(message) => {
            setEditing(null);
            setNotice(message);
            list.reload();
          }}
        />
      )}
      <section className={`${adminCard} min-w-0`}>
        <DataState loading={list.loading && !list.data} error={list.error} empty={methods.length === 0} emptyTitle="No shipping methods" emptyHint="Without a method, delivery is free. Add one to charge for it.">
          <ul className="divide-y divide-[#E6EAE7]">
            {methods.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2"><span className="font-semibold">{m.name}</span><span className="font-mono text-xs text-[#4A5550]">{m.code}</span><Pill tone={m.isActive ? 'green' : 'gray'}>{m.isActive ? 'On' : 'Off'}</Pill></p>
                  <p className="text-sm text-[#4A5550]">
                    {m.baseMinor === 0 ? 'Free' : formatPaise(m.baseMinor)}
                    {m.freeAboveMinor !== null ? ` · free above ${formatPaise(m.freeAboveMinor)}` : ''} · {eta(m)} · {m.states.length === 0 ? 'all of India' : m.states.length > 3 ? `${m.states.length} states` : m.states.join(', ')}
                  </p>
                  {m.description && <p className="break-words text-sm">{m.description}</p>}
                </div>
                <div className="flex gap-2">
                  <button className={adminGhostButton} onClick={() => setEditing(m)}>Edit</button>
                  {canPrice && <button className={adminGhostButton} disabled={busyId === m.id} onClick={() => void toggle(m)}>{m.isActive ? 'Turn off' : 'Turn on'}</button>}
                </div>
              </li>
            ))}
          </ul>
        </DataState>
      </section>
    </AdminPage>
  );
}

function MethodForm({
  method,
  canPrice,
  run,
  onClose,
  onSaved,
}: {
  method: ShippingMethod | null;
  canPrice: boolean;
  run: <T>(call: () => Promise<T>) => Promise<T>;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const isNew = method === null;
  const [code, setCode] = useState(method?.code ?? '');
  const [name, setName] = useState(method?.name ?? '');
  const [description, setDescription] = useState(method?.description ?? '');
  const [fee, setFee] = useState(method ? paiseToRupees(method.baseMinor) : '');
  const [freeAbove, setFreeAbove] = useState(paiseToRupees(method?.freeAboveMinor));
  const [etaMin, setEtaMin] = useState(String(method?.etaMinDays ?? 3));
  const [etaMax, setEtaMax] = useState(String(method?.etaMaxDays ?? 7));
  const [states, setStates] = useState<string[]>(method?.states ?? []);
  const [sortOrder, setSortOrder] = useState(String(method?.sortOrder ?? 0));
  const [isActive, setIsActive] = useState(method?.isActive ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    const baseMinor = rupeesToPaise(fee);
    if (baseMinor === null) return setError('Enter the delivery fee in rupees. Use 0 for free delivery.');
    let freeAboveMinor: number | null = null;
    if (freeAbove.trim()) {
      freeAboveMinor = rupeesToPaise(freeAbove);
      if (freeAboveMinor === null || freeAboveMinor < 1) return setError('Enter a valid “free above” order value in rupees.');
    }
    const min = Number(etaMin);
    const max = Number(etaMax);
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max > 90) return setError('Delivery time must be whole days between 0 and 90.');
    if (max < min) return setError('The longest delivery time cannot be shorter than the quickest.');
    const order = Number(sortOrder);
    if (!Number.isInteger(order) || order < -1000 || order > 1000) return setError('Display order must be a whole number between -1000 and 1000.');

    const shared = { name: name.trim(), description: description.trim() || null, baseMinor, freeAboveMinor, etaMinDays: min, etaMaxDays: max, states, sortOrder: order, isActive };
    setBusy(true);
    try {
      if (isNew) await run(() => adminPost('/admin/shipping-methods', { code: code.trim(), ...shared }));
      else await run(() => adminPatch(`/admin/shipping-methods/${method.id}`, shared));
      onSaved(isNew ? `${shared.name} added.` : `${shared.name} updated.`);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className={`${adminCard} space-y-4 p-6`} aria-label={isNew ? 'New shipping method' : `Edit ${method.name}`}>
      <h2 className="font-heading text-xl font-bold">{isNew ? 'New shipping method' : `Edit ${method.name}`}</h2>
      {error && <Alert kind="error">{error}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Code" hint={isNew ? 'Capital letters, digits and _ (2 to 30). Used internally and cannot be changed later.' : 'The code cannot be changed.'}>
          <input required={isNew} disabled={!isNew} pattern="[A-Z0-9_]{2,30}" maxLength={30} className={`${adminInput} font-mono`} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />
        </Field>
        <Field label="Name shown to customers"><input required minLength={2} maxLength={80} className={adminInput} value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Delivery fee (₹)" hint={canPrice ? 'Use 0 for free delivery.' : 'Changing the fee needs the pricing permission.'}><input required disabled={!canPrice} inputMode="decimal" className={adminInput} value={fee} onChange={(e) => setFee(e.target.value)} /></Field>
        {(rupeesToPaise(fee) ?? 0) > 0 && (
          <div className="sm:col-span-2">
            <Alert kind="success">
              The fee is GST-inclusive, like product prices. On each invoice it is taxed with the goods it carries, at their GST rate (split by value when an order mixes rates).
            </Alert>
          </div>
        )}
        <Field label="Free above order value (₹, optional)" hint="Delivery becomes free once the items total reaches this."><input disabled={!canPrice} inputMode="decimal" className={adminInput} value={freeAbove} onChange={(e) => setFreeAbove(e.target.value)} /></Field>
        <Field label="Quickest delivery (days)"><input required inputMode="numeric" className={adminInput} value={etaMin} onChange={(e) => setEtaMin(e.target.value)} /></Field>
        <Field label="Longest delivery (days)"><input required inputMode="numeric" className={adminInput} value={etaMax} onChange={(e) => setEtaMax(e.target.value)} /></Field>
        <Field label="Display order" hint="Smaller numbers are shown first."><input inputMode="numeric" className={adminInput} value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} /></Field>
        <Field label="Description (optional)"><input maxLength={200} className={adminInput} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
      </div>
      <fieldset>
        <legend className="text-sm font-medium">States served <span className="font-normal text-[#4A5550]">({states.length === 0 ? 'all of India' : `${states.length} selected`})</span></legend>
        <p className="mb-2 text-xs text-[#4A5550]">{canPrice ? 'Leave every state unticked to deliver everywhere.' : 'Changing where a method is offered needs the pricing permission.'}</p>
        <div className="grid max-h-56 gap-1 overflow-y-auto rounded-xl border border-[#E6EAE7] p-3 sm:grid-cols-2 lg:grid-cols-3">
          {INDIAN_STATES.map((s) => (
            <label key={s} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={states.includes(s)} disabled={!canPrice || (!states.includes(s) && states.length >= 40)} onChange={(e) => setStates((list) => (e.target.checked ? [...list, s] : list.filter((x) => x !== s)))} />
              {s}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" disabled={!canPrice} checked={isActive} onChange={(e) => setIsActive(e.target.checked)} /> Turned on (customers can choose it)</label>
      <div className="flex justify-end gap-3">
        <button type="button" className={adminGhostButton} disabled={busy} onClick={onClose}>Cancel</button>
        <button className={adminButton} disabled={busy}>{busy ? 'Saving…' : isNew ? 'Add method' : 'Save changes'}</button>
      </div>
    </form>
  );
}
