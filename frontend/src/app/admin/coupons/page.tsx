'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { useAdminSession } from '@/components/AdminContext';
import { Alert, AdminPage, DataState, Field, Pager, Pill, adminButton, adminCard, adminGhostButton, adminInput } from '@/components/AdminKit';
import { adminGet, adminList, adminPatch, adminPost, paiseToRupees, rupeesToPaise } from '@/lib/admin-api';
import { useAdminQuery } from '@/lib/useAdminQuery';
import { formatDateTime, formatPaise } from '@/lib/formatters';

interface Coupon {
  id: string;
  code: string;
  description: string | null;
  discountType: 'PERCENTAGE' | 'FIXED_AMOUNT';
  percentBps: number | null;
  amountMinor: number | null;
  maxDiscountMinor: number | null;
  scope: 'ALL_ITEMS' | 'PRODUCTS' | 'CATEGORIES';
  minCartMinor: number;
  startsAt: string | null;
  expiresAt: string | null;
  maxRedemptions: number | null;
  redeemedCount: number;
  perCustomerLimit: number | null;
  isActive: boolean;
}
interface CouponDetail extends Coupon {
  products: { productId: string }[];
  categories: { categoryId: string }[];
}
interface CategoryOption {
  id: string;
  name: string;
}

const pad = (n: number) => String(n).padStart(2, '0');
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const toIso = (local: string): string | null => (local ? new Date(local).toISOString() : null);
const errorText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong. Please try again.');
/** "12.5" -> 1250 basis points; same decimal-to-hundredths maths as rupees to paise, no floating point. */
const percentToBps = (text: string) => rupeesToPaise(text);

function describe(c: Coupon): string {
  const value = c.discountType === 'PERCENTAGE' ? `${(c.percentBps ?? 0) / 100}% off${c.maxDiscountMinor ? `, up to ${formatPaise(c.maxDiscountMinor)}` : ''}` : `${formatPaise(c.amountMinor ?? 0)} off`;
  const scope = c.scope === 'ALL_ITEMS' ? '' : c.scope === 'CATEGORIES' ? ' · selected categories' : ' · selected products';
  return `${value}${scope}${c.minCartMinor ? ` · min. cart ${formatPaise(c.minCartMinor)}` : ''}`;
}
function state(c: Coupon): { label: string; tone: 'green' | 'amber' | 'gray' | 'red' } {
  const now = Date.now();
  if (!c.isActive) return { label: 'Paused', tone: 'gray' };
  if (c.expiresAt && new Date(c.expiresAt).getTime() < now) return { label: 'Expired', tone: 'red' };
  if (c.startsAt && new Date(c.startsAt).getTime() > now) return { label: 'Scheduled', tone: 'amber' };
  if (c.maxRedemptions !== null && c.redeemedCount >= c.maxRedemptions) return { label: 'Fully used', tone: 'gray' };
  return { label: 'Live', tone: 'green' };
}

export default function AdminCouponsPage() {
  const { withStepUp } = useAdminSession();
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<'new' | Coupon | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const list = useAdminQuery(() => adminList<Coupon>('/admin/coupons', { page, pageSize: 20 }), [page]);
  const rows = list.data?.items ?? [];

  async function toggle(c: Coupon) {
    setBusyId(c.id);
    setError('');
    setNotice('');
    try {
      await withStepUp(() => adminPatch(`/admin/coupons/${c.id}`, { isActive: !c.isActive }));
      setNotice(c.isActive ? `${c.code} paused. Customers can no longer use it.` : `${c.code} resumed.`);
      list.reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <AdminPage
      eyebrow="Marketing"
      title="Coupons"
      subtitle="Create offers that the server checks at every cart and checkout. Discounts are always calculated on the server."
      actions={<button className={`${adminButton} inline-flex items-center gap-1.5`} onClick={() => setEditing('new')}><Plus className="h-4 w-4" /> New coupon</button>}
    >
      {error && <Alert kind="error">{error}</Alert>}
      {notice && <Alert kind="success">{notice}</Alert>}
      {editing && (
        <CouponForm
          key={editing === 'new' ? 'new' : editing.id}
          coupon={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(message) => {
            setEditing(null);
            setNotice(message);
            list.reload();
          }}
        />
      )}
      <section className={`${adminCard} min-w-0`}>
        <DataState loading={list.loading && !list.data} error={list.error} empty={rows.length === 0} emptyTitle="No coupons yet" emptyHint="Create your first offer with the New coupon button.">
          <ul className="divide-y divide-[#E6EAE7]">
            {rows.map((c) => {
              const s = state(c);
              return (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2"><span className="break-all font-mono text-base font-bold">{c.code}</span><Pill tone={s.tone}>{s.label}</Pill></p>
                    <p className="text-sm text-[#4A5550]">{describe(c)}</p>
                    {c.description && <p className="break-words text-sm">{c.description}</p>}
                    <p className="text-xs text-[#4A5550]">
                      Used {c.redeemedCount}{c.maxRedemptions !== null ? ` of ${c.maxRedemptions}` : ''}{c.perCustomerLimit !== null ? ` · ${c.perCustomerLimit} per customer` : ''}
                      {c.startsAt ? ` · from ${formatDateTime(c.startsAt)}` : ''}{c.expiresAt ? ` · until ${formatDateTime(c.expiresAt)}` : ''}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button className={adminGhostButton} onClick={() => setEditing(c)}>Edit</button>
                    <button className={adminGhostButton} disabled={busyId === c.id} onClick={() => void toggle(c)}>{c.isActive ? 'Pause' : 'Resume'}</button>
                  </div>
                </li>
              );
            })}
          </ul>
          {list.data && <Pager meta={list.data.meta} onPage={setPage} />}
        </DataState>
      </section>
    </AdminPage>
  );
}

function CouponForm({ coupon, onClose, onSaved }: { coupon: Coupon | null; onClose: () => void; onSaved: (message: string) => void }) {
  const { withStepUp, can } = useAdminSession();
  const isNew = coupon === null;
  // The category list needs products.read, which a finance role may not have: the form still works without it
  // (whole-cart coupons; a category coupon keeps the categories it has).
  const canReadCategories = can('products.read');
  const detail = useAdminQuery(() => (coupon ? adminGet<CouponDetail>(`/admin/coupons/${coupon.id}`) : Promise.resolve(null)), [coupon?.id]);
  const categories = useAdminQuery(
    () => (canReadCategories ? adminGet<CategoryOption[]>('/admin/categories') : Promise.resolve(null)),
    [canReadCategories],
  );
  if (!isNew && !detail.data) return <section className={`${adminCard} p-6 text-sm`}>{detail.error ? <Alert kind="error">{detail.error}</Alert> : 'Loading…'}</section>;
  if (canReadCategories && !categories.data && !categories.error) return <section className={`${adminCard} p-6 text-sm`}>Loading…</section>;
  return <CouponFields coupon={coupon} detail={detail.data} categories={categories.data ?? null} run={withStepUp} onClose={onClose} onSaved={onSaved} />;
}

function CouponFields({
  coupon,
  detail,
  categories,
  run,
  onClose,
  onSaved,
}: {
  coupon: Coupon | null;
  detail: CouponDetail | null;
  /** null: this account may not list categories (no products.read). */
  categories: CategoryOption[] | null;
  run: <T>(call: () => Promise<T>) => Promise<T>;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const isNew = coupon === null;
  const [code, setCode] = useState(coupon?.code ?? '');
  const [description, setDescription] = useState(coupon?.description ?? '');
  const [type, setType] = useState<'PERCENTAGE' | 'FIXED_AMOUNT'>(coupon?.discountType ?? 'PERCENTAGE');
  const [percent, setPercent] = useState(coupon?.percentBps ? String(coupon.percentBps / 100) : '');
  const [amount, setAmount] = useState(paiseToRupees(coupon?.amountMinor));
  const [maxDiscount, setMaxDiscount] = useState(paiseToRupees(coupon?.maxDiscountMinor));
  const [minCart, setMinCart] = useState(coupon?.minCartMinor ? paiseToRupees(coupon.minCartMinor) : '');
  const [scope, setScope] = useState<'ALL_ITEMS' | 'CATEGORIES'>(coupon?.scope === 'CATEGORIES' ? 'CATEGORIES' : 'ALL_ITEMS');
  const [categoryIds, setCategoryIds] = useState<string[]>(detail?.categories.map((c) => c.categoryId) ?? []);
  const [startsAt, setStartsAt] = useState(toLocalInput(coupon?.startsAt ?? null));
  const [expiresAt, setExpiresAt] = useState(toLocalInput(coupon?.expiresAt ?? null));
  const [maxRedemptions, setMaxRedemptions] = useState(coupon?.maxRedemptions ? String(coupon.maxRedemptions) : '');
  const [perCustomer, setPerCustomer] = useState(coupon?.perCustomerLimit ? String(coupon.perCustomerLimit) : '');
  const [isActive, setIsActive] = useState(coupon?.isActive ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const productScoped = coupon?.scope === 'PRODUCTS';

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    const fail = (message: string) => {
      setError(message);
      return null;
    };
    const wholeNumber = (text: string, label: string, max: number) => {
      if (!text.trim()) return null;
      if (!/^\d{1,9}$/.test(text.trim()) || Number(text) < 1 || Number(text) > max) return fail(`${label} must be a whole number from 1 to ${max.toLocaleString('en-IN')}.`) ?? undefined;
      return Number(text);
    };

    let percentBps: number | undefined;
    let amountMinor: number | undefined;
    if (type === 'PERCENTAGE') {
      const bps = percentToBps(percent);
      if (bps === null || bps < 1 || bps > 10000) return fail('Enter a percentage between 0.01 and 100.') ?? undefined;
      percentBps = bps;
    } else {
      const minor = rupeesToPaise(amount);
      if (minor === null || minor < 1) return fail('Enter the discount amount in rupees.') ?? undefined;
      amountMinor = minor;
    }
    let maxDiscountMinor: number | null = null;
    if (type === 'PERCENTAGE' && maxDiscount.trim()) {
      maxDiscountMinor = rupeesToPaise(maxDiscount);
      if (maxDiscountMinor === null || maxDiscountMinor < 1) return fail('Enter a valid maximum discount in rupees.') ?? undefined;
    }
    const minCartMinor = minCart.trim() ? rupeesToPaise(minCart) : 0;
    if (minCartMinor === null) return fail('Enter the minimum cart value in rupees.') ?? undefined;
    const max = wholeNumber(maxRedemptions, 'Total uses', 10_000_000);
    const per = wholeNumber(perCustomer, 'Uses per customer', 1000);
    if (max === undefined || per === undefined) return;
    if (scope === 'CATEGORIES' && categoryIds.length === 0) return fail('Choose at least one category.') ?? undefined;
    const startIso = toIso(startsAt);
    const endIso = toIso(expiresAt);
    if (startIso && endIso && endIso <= startIso) return fail('The coupon must expire after it starts.') ?? undefined;

    const shared = {
      description: description.trim() || undefined,
      ...(type === 'PERCENTAGE' ? { percentBps } : { amountMinor }),
      maxDiscountMinor,
      minCartMinor,
      startsAt: startIso,
      expiresAt: endIso,
      maxRedemptions: max,
      perCustomerLimit: per,
      isActive,
    };
    setBusy(true);
    try {
      if (isNew) {
        await run(() => adminPost('/admin/coupons', { code: code.trim(), discountType: type, scope, ...(scope === 'CATEGORIES' ? { categoryIds } : {}), ...shared }));
        onSaved(`Coupon ${code.trim().toUpperCase()} created.`);
      } else {
        await run(() => adminPatch(`/admin/coupons/${coupon.id}`, { ...shared, description: description.trim(), ...(productScoped ? {} : { scope, categoryIds: scope === 'CATEGORIES' ? categoryIds : [] }) }));
        onSaved(`Coupon ${coupon.code} updated.`);
      }
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className={`${adminCard} space-y-4 p-6`} aria-label={isNew ? 'New coupon' : `Edit ${coupon.code}`}>
      <h2 className="font-heading text-xl font-bold">{isNew ? 'New coupon' : `Edit ${coupon.code}`}</h2>
      {error && <Alert kind="error">{error}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Code" hint={isNew ? '3 to 40 letters, digits, - or _. Customers type it in capitals or small letters.' : 'The code cannot be changed.'}>
          <input required={isNew} disabled={!isNew} minLength={3} maxLength={40} className={`${adminInput} font-mono uppercase`} value={code} onChange={(e) => setCode(e.target.value)} />
        </Field>
        <Field label="Description (optional)">
          <input maxLength={200} className={adminInput} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label="Discount type">
          <select disabled={!isNew} className={adminInput} value={type} onChange={(e) => setType(e.target.value as typeof type)}>
            <option value="PERCENTAGE">Percentage off</option>
            <option value="FIXED_AMOUNT">Fixed amount off</option>
          </select>
        </Field>
        {type === 'PERCENTAGE' ? (
          <Field label="Percentage (%)">
            <input required inputMode="decimal" className={adminInput} value={percent} onChange={(e) => setPercent(e.target.value)} />
          </Field>
        ) : (
          <Field label="Amount off (₹)">
            <input required inputMode="decimal" className={adminInput} value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
        )}
        {type === 'PERCENTAGE' && (
          <Field label="Maximum discount (₹, optional)" hint="Caps the saving on big carts.">
            <input inputMode="decimal" className={adminInput} value={maxDiscount} onChange={(e) => setMaxDiscount(e.target.value)} />
          </Field>
        )}
        <Field label="Minimum cart value (₹, optional)">
          <input inputMode="decimal" className={adminInput} value={minCart} onChange={(e) => setMinCart(e.target.value)} />
        </Field>
        <Field label="Starts (optional)"><input type="datetime-local" className={adminInput} value={startsAt} onChange={(e) => setStartsAt(e.target.value)} /></Field>
        <Field label="Expires (optional)"><input type="datetime-local" className={adminInput} value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} /></Field>
        <Field label="Total uses (optional)" hint="Leave blank for unlimited.">
          <input inputMode="numeric" className={adminInput} value={maxRedemptions} onChange={(e) => setMaxRedemptions(e.target.value)} />
        </Field>
        <Field label="Uses per customer (optional)">
          <input inputMode="numeric" className={adminInput} value={perCustomer} onChange={(e) => setPerCustomer(e.target.value)} />
        </Field>
      </div>
      {productScoped ? (
        <Alert kind="warning">This coupon applies to selected products. Its product list is kept as it is; the other settings can be edited here.</Alert>
      ) : (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Applies to</legend>
          <label className="flex items-center gap-2 text-sm"><input type="radio" checked={scope === 'ALL_ITEMS'} onChange={() => setScope('ALL_ITEMS')} /> Everything in the cart</label>
          <label className="flex items-center gap-2 text-sm"><input type="radio" checked={scope === 'CATEGORIES'} disabled={categories === null && scope !== 'CATEGORIES'} onChange={() => setScope('CATEGORIES')} /> Only selected categories</label>
          {categories === null && (
            <p className="pl-6 text-xs text-[#4A5550]">
              {scope === 'CATEGORIES'
                ? 'This coupon keeps its current categories: changing them needs product access.'
                : 'Category coupons need product access; ask a product manager to set the categories.'}
            </p>
          )}
          {scope === 'CATEGORIES' && categories !== null && (
            <div className="grid gap-2 pl-6 sm:grid-cols-2">
              {categories.map((c) => (
                <label key={c.id} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={categoryIds.includes(c.id)} onChange={(e) => setCategoryIds((ids) => (e.target.checked ? [...ids, c.id] : ids.filter((x) => x !== c.id)))} />
                  <span className="break-words">{c.name}</span>
                </label>
              ))}
            </div>
          )}
        </fieldset>
      )}
      <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} /> Active (customers can use it)</label>
      <div className="flex justify-end gap-3">
        <button type="button" className={adminGhostButton} disabled={busy} onClick={onClose}>Cancel</button>
        <button className={adminButton} disabled={busy}>{busy ? 'Saving…' : isNew ? 'Create coupon' : 'Save changes'}</button>
      </div>
    </form>
  );
}
