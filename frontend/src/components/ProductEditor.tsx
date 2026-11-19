'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Plus, Trash2, Upload } from 'lucide-react';
import { useAdminSession } from '@/components/AdminAccess';
import { Alert, AdminPage, Field, Pill, adminButton, adminCard, adminDangerButton, adminGhostButton, adminInput } from '@/components/AdminKit';
import { adminDelete, adminGet, adminPatch, adminPost, paiseToRupees, rupeesToPaise } from '@/lib/admin-api';
import { adminRequest } from '@/lib/admin-session';
import { useAdminQuery } from '@/lib/useAdminQuery';
import { formatPaise } from '@/lib/formatters';

interface Variant {
  id: string;
  sku: string;
  name: string | null;
  priceMinor: number;
  salePriceMinor: number | null;
  saleStartsAt: string | null;
  saleEndsAt: string | null;
  isActive: boolean;
  weightGrams: number | null;
  available: number;
}
interface AdminProduct {
  id: string;
  slug: string;
  name: string;
  summary: string | null;
  descriptionHtml: string;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  brandId: string | null;
  gstRateBps: number;
  hsnCode: string | null;
  categories: { id: string; name: string }[];
  tags: string[];
  attributes: { name: string; value: string }[];
  images: { id: string; url: string | null; altText: string | null }[];
  variants: Variant[];
  updatedAt: string;
}
interface Brand {
  id: string;
  name: string;
}
interface CategoryOption {
  id: string;
  name: string;
}

const GST_SLABS = [0, 25, 300, 500, 1200, 1800, 2800, 4000];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const STATUS_TONE = { PUBLISHED: 'green', DRAFT: 'amber', ARCHIVED: 'gray' } as const;

const pad = (n: number) => String(n).padStart(2, '0');
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const toIso = (local: string): string | null => (local ? new Date(local).toISOString() : null);
const errorText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong. Please try again.');

export function ProductEditor({ id }: { id?: string }) {
  const product = useAdminQuery(() => (id ? adminGet<AdminProduct>(`/admin/products/${id}`) : Promise.resolve(null)), [id]);
  const brands = useAdminQuery(() => adminGet<Brand[]>('/admin/brands'), []);
  const categories = useAdminQuery(() => adminGet<CategoryOption[]>('/admin/categories'), []);

  const loading = (id ? product.loading && !product.data : false) || (brands.loading && !brands.data) || (categories.loading && !categories.data);
  const loadError = product.error || brands.error || categories.error;

  return (
    <AdminPage
      eyebrow={<>Catalogue / <Link href="/admin/products" className="underline">Products</Link></>}
      title={id ? 'Edit product' : 'Add product'}
      subtitle={id ? undefined : 'New products start as a draft. Add at least one variant (SKU and price), then publish.'}
    >
      {loadError && <Alert kind="error">{loadError}</Alert>}
      {loading ? (
        <p role="status" className="text-sm text-[#4A5550]">Loading…</p>
      ) : brands.data && categories.data && (!id || product.data) ? (
        <EditorBody
          key={product.data?.id ?? 'new'}
          product={product.data}
          brands={brands.data}
          categories={categories.data}
          onChanged={product.reload}
        />
      ) : null}
    </AdminPage>
  );
}

function EditorBody({
  product,
  brands,
  categories,
  onChanged,
}: {
  product: AdminProduct | null;
  brands: Brand[];
  categories: CategoryOption[];
  onChanged: () => void;
}) {
  const router = useRouter();
  const { withStepUp } = useAdminSession();
  const [name, setName] = useState(product?.name ?? '');
  const [slug, setSlug] = useState(product?.slug ?? '');
  const [summary, setSummary] = useState(product?.summary ?? '');
  const [description, setDescription] = useState(product?.descriptionHtml ?? '');
  const [brandId, setBrandId] = useState(product?.brandId ?? '');
  const [categoryIds, setCategoryIds] = useState<string[]>(product?.categories.map((c) => c.id) ?? []);
  const [tags, setTags] = useState(product?.tags.join(', ') ?? '');
  const [attributes, setAttributes] = useState(product?.attributes.map(({ name, value }) => ({ name, value })) ?? []);
  const [gst, setGst] = useState(product?.gstRateBps ?? 1800);
  const [hsn, setHsn] = useState(product?.hsnCode ?? '');
  const [newVariants, setNewVariants] = useState<VariantDraft[]>(product ? [] : [emptyVariant()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  function productPayload() {
    return {
      name: name.trim(),
      summary: summary.trim(),
      descriptionHtml: description,
      brandId: brandId || null,
      categoryIds,
      tags: [...new Set(tags.split(',').map((t) => t.trim()).filter(Boolean))],
      attributes: attributes.filter((a) => a.name.trim() && a.value.trim()).map((a) => ({ name: a.name.trim(), value: a.value.trim() })),
      gstRateBps: gst,
      hsnCode: hsn.trim() || null,
    };
  }

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const saveProduct = (event: React.FormEvent) => {
    event.preventDefault();
    void run(async () => {
      if (categoryIds.length === 0) throw new Error('Choose at least one category.');
      if (!product) {
        const variants = newVariants.map((v, i) => {
          const parsed = parseVariant(v, true);
          if (typeof parsed === 'string') throw new Error(`Variant ${i + 1}: ${parsed}`);
          return parsed;
        });
        const created = await withStepUp(() => adminPost<{ id: string }>('/admin/products', { ...productPayload(), ...(slug.trim() ? { slug: slug.trim() } : {}), variants }));
        router.replace(`/admin/products/${created.id}`);
        return;
      }
      await withStepUp(() => adminPatch(`/admin/products/${product.id}`, productPayload()));
      setNotice('Product saved.');
      onChanged();
    });
  };

  const setStatus = (action: 'publish' | 'unpublish' | 'archive') =>
    run(async () => {
      if (!product) return;
      await withStepUp(() => adminPost(`/admin/products/${product.id}/${action}`));
      setNotice({ publish: 'Product is live.', unpublish: 'Product moved back to draft.', archive: 'Product archived.' }[action]);
      onChanged();
    });

  return (
    <div className="space-y-6">
      {error && <Alert kind="error">{error}</Alert>}
      {notice && <Alert kind="success">{notice}</Alert>}

      {product && (
        <div className={`${adminCard} flex flex-wrap items-center justify-between gap-3 p-4`}>
          <div className="flex items-center gap-3">
            <Pill tone={STATUS_TONE[product.status]}>{product.status.toLowerCase()}</Pill>
            <span className="break-all text-sm text-[#4A5550]">/{product.slug}</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {product.status !== 'PUBLISHED' && product.status !== 'ARCHIVED' && (
              <button className={adminButton} disabled={busy} onClick={() => void setStatus('publish')}>Publish</button>
            )}
            {product.status === 'PUBLISHED' && (
              <button className={adminGhostButton} disabled={busy} onClick={() => void setStatus('unpublish')}>Unpublish</button>
            )}
            {product.status !== 'ARCHIVED' && (
              <button className={adminGhostButton} disabled={busy} onClick={() => void setStatus('archive')}>Archive</button>
            )}
          </div>
        </div>
      )}

      <form onSubmit={saveProduct} className={`${adminCard} space-y-5 p-6`}>
        <h2 className="font-heading text-xl font-bold">The essentials</h2>
        <Field label="Product name">
          <input required maxLength={200} className={adminInput} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        {!product && (
          <Field label="URL slug (optional)" hint="Lowercase letters, digits and dashes. Leave blank to generate it from the name.">
            <input maxLength={160} pattern="[a-z0-9]+(-[a-z0-9]+)*" className={adminInput} value={slug} onChange={(e) => setSlug(e.target.value)} />
          </Field>
        )}
        <Field label="Summary" hint="Up to 500 characters, shown on product cards.">
          <textarea maxLength={500} rows={2} className={adminInput} value={summary} onChange={(e) => setSummary(e.target.value)} />
        </Field>
        <Field label="Description" hint="Basic formatting HTML is allowed. Scripts and unsafe markup are removed when you save.">
          <textarea maxLength={50000} rows={6} className={`${adminInput} font-mono`} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Brand">
            <select className={adminInput} value={brandId} onChange={(e) => setBrandId(e.target.value)}>
              <option value="">No brand</option>
              {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </Field>
          <Field label="Tags" hint="Comma separated, up to 20.">
            <input className={adminInput} value={tags} onChange={(e) => setTags(e.target.value)} />
          </Field>
        </div>
        <fieldset>
          <legend className="text-sm font-medium">Categories <span className="font-normal text-[#4A5550]">(1 to 10)</span></legend>
          {categories.length === 0 ? (
            <p className="mt-2 text-sm text-[#4A5550]">No categories yet. <Link className="underline" href="/admin/categories">Create one first.</Link></p>
          ) : (
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {categories.map((c) => (
                <label key={c.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={categoryIds.includes(c.id)}
                    disabled={!categoryIds.includes(c.id) && categoryIds.length >= 10}
                    onChange={(e) => setCategoryIds((ids) => (e.target.checked ? [...ids, c.id] : ids.filter((x) => x !== c.id)))}
                  />
                  <span className="break-words">{c.name}</span>
                </label>
              ))}
            </div>
          )}
        </fieldset>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="GST slab">
            <select className={adminInput} value={gst} onChange={(e) => setGst(Number(e.target.value))}>
              {GST_SLABS.map((bps) => <option key={bps} value={bps}>{bps / 100}%</option>)}
            </select>
          </Field>
          <Field label="HSN code (optional)" hint="4 to 8 digits.">
            <input inputMode="numeric" pattern="\d{4,8}" className={adminInput} value={hsn} onChange={(e) => setHsn(e.target.value)} />
          </Field>
        </div>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Specifications</legend>
          {attributes.map((a, i) => (
            <div key={i} className="flex gap-2">
              <input aria-label="Specification name" placeholder="Name" maxLength={80} className={adminInput} value={a.name} onChange={(e) => setAttributes((list) => list.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
              <input aria-label="Specification value" placeholder="Value" maxLength={300} className={adminInput} value={a.value} onChange={(e) => setAttributes((list) => list.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
              <button type="button" aria-label="Remove specification" className={adminGhostButton} onClick={() => setAttributes((list) => list.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></button>
            </div>
          ))}
          {attributes.length < 50 && (
            <button type="button" className="text-sm font-semibold text-[#116644]" onClick={() => setAttributes((list) => [...list, { name: '', value: '' }])}>+ Add specification</button>
          )}
        </fieldset>

        {!product && (
          <div className="space-y-4 border-t border-[#E6EAE7] pt-5">
            <h2 className="font-heading text-xl font-bold">Variants and pricing</h2>
            {newVariants.map((v, i) => (
              <div key={i} className="rounded-xl border border-[#E6EAE7] p-4">
                <VariantFields draft={v} isNew onChange={(next) => setNewVariants((list) => list.map((x, j) => (j === i ? next : x)))} />
                {newVariants.length > 1 && (
                  <button type="button" className="mt-3 text-sm font-semibold text-red-700" onClick={() => setNewVariants((list) => list.filter((_, j) => j !== i))}>Remove variant</button>
                )}
              </div>
            ))}
            {newVariants.length < 50 && (
              <button type="button" className="text-sm font-semibold text-[#116644]" onClick={() => setNewVariants((list) => [...list, emptyVariant()])}>+ Add another variant</button>
            )}
          </div>
        )}

        <div className="flex justify-end gap-3 border-t border-[#E6EAE7] pt-5">
          <Link href="/admin/products" className={adminGhostButton}>Back to products</Link>
          <button className={adminButton} disabled={busy}>{busy ? 'Saving…' : product ? 'Save changes' : 'Create draft'}</button>
        </div>
      </form>

      {product && <VariantsPanel product={product} onChanged={onChanged} />}
      {product && <ImagesPanel product={product} onChanged={onChanged} />}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ variants

interface VariantDraft {
  sku: string;
  name: string;
  price: string;
  salePrice: string;
  saleStarts: string;
  saleEnds: string;
  weight: string;
  isActive: boolean;
}
const emptyVariant = (): VariantDraft => ({ sku: '', name: '', price: '', salePrice: '', saleStarts: '', saleEnds: '', weight: '', isActive: true });
const draftFrom = (v: Variant): VariantDraft => ({
  sku: v.sku,
  name: v.name ?? '',
  price: paiseToRupees(v.priceMinor),
  salePrice: paiseToRupees(v.salePriceMinor),
  saleStarts: toLocalInput(v.saleStartsAt),
  saleEnds: toLocalInput(v.saleEndsAt),
  weight: v.weightGrams === null ? '' : String(v.weightGrams),
  isActive: v.isActive,
});

/** Turns the form into an API body, or returns a message. Create omits empty optionals; update sends null to clear them. */
function parseVariant(v: VariantDraft, create: boolean) {
  const priceMinor = rupeesToPaise(v.price);
  if (priceMinor === null || priceMinor < 1) return 'enter a price in rupees, e.g. 499 or 499.50.';
  const salePriceMinor = v.salePrice.trim() ? rupeesToPaise(v.salePrice) : null;
  if (v.salePrice.trim() && (salePriceMinor === null || salePriceMinor < 1)) return 'enter a valid sale price.';
  if (salePriceMinor !== null && salePriceMinor >= priceMinor) return 'the sale price must be lower than the price.';
  const saleStartsAt = toIso(v.saleStarts);
  const saleEndsAt = toIso(v.saleEnds);
  if (saleStartsAt && saleEndsAt && saleEndsAt <= saleStartsAt) return 'the sale must end after it starts.';
  if (v.weight.trim() && !/^\d{1,7}$/.test(v.weight.trim())) return 'weight must be a whole number of grams.';
  const weightGrams = v.weight.trim() ? Number(v.weight) : null;
  if (create) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v.sku.trim())) return 'SKU: letters, digits, . _ - (max 64).';
    return {
      sku: v.sku.trim(),
      ...(v.name.trim() ? { name: v.name.trim() } : {}),
      priceMinor,
      ...(salePriceMinor !== null ? { salePriceMinor } : {}),
      ...(saleStartsAt ? { saleStartsAt } : {}),
      ...(saleEndsAt ? { saleEndsAt } : {}),
      isActive: v.isActive,
      ...(weightGrams !== null ? { weightGrams } : {}),
    };
  }
  return { name: v.name.trim() || null, priceMinor, salePriceMinor, saleStartsAt, saleEndsAt, isActive: v.isActive, weightGrams };
}

function VariantFields({ draft, onChange, isNew }: { draft: VariantDraft; onChange: (v: VariantDraft) => void; isNew: boolean }) {
  const set = (patch: Partial<VariantDraft>) => onChange({ ...draft, ...patch });
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Field label="SKU">
        <input required={isNew} disabled={!isNew} maxLength={64} className={adminInput} value={draft.sku} onChange={(e) => set({ sku: e.target.value })} />
      </Field>
      <Field label="Variant name">
        <input maxLength={120} placeholder="e.g. Red, 2 tier" className={adminInput} value={draft.name} onChange={(e) => set({ name: e.target.value })} />
      </Field>
      <Field label="Price (₹, GST inclusive)">
        <input required inputMode="decimal" className={adminInput} value={draft.price} onChange={(e) => set({ price: e.target.value })} />
      </Field>
      <Field label="Sale price (₹)">
        <input inputMode="decimal" className={adminInput} value={draft.salePrice} onChange={(e) => set({ salePrice: e.target.value })} />
      </Field>
      <Field label="Sale starts">
        <input type="datetime-local" className={adminInput} value={draft.saleStarts} onChange={(e) => set({ saleStarts: e.target.value })} />
      </Field>
      <Field label="Sale ends">
        <input type="datetime-local" className={adminInput} value={draft.saleEnds} onChange={(e) => set({ saleEnds: e.target.value })} />
      </Field>
      <Field label="Weight (grams)">
        <input inputMode="numeric" className={adminInput} value={draft.weight} onChange={(e) => set({ weight: e.target.value })} />
      </Field>
      <label className="flex items-end gap-2 pb-2.5 text-sm font-medium">
        <input type="checkbox" checked={draft.isActive} onChange={(e) => set({ isActive: e.target.checked })} /> Active (can be bought)
      </label>
    </div>
  );
}

function VariantRow({ variant, onChanged }: { variant: Variant; onChanged: () => void }) {
  const { withStepUp } = useAdminSession();
  const [draft, setDraft] = useState(() => draftFrom(variant));
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save(event: React.FormEvent) {
    event.preventDefault();
    const body = parseVariant(draft, false);
    if (typeof body === 'string') return setError(`Variant ${variant.sku}: ${body}`);
    setBusy(true);
    setError('');
    try {
      await withStepUp(() => adminPatch(`/admin/variants/${variant.id}`, body));
      setOpen(false);
      onChanged();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!window.confirm(`Delete variant ${variant.sku}? Past orders keep their record.`)) return;
    setBusy(true);
    setError('');
    try {
      await withStepUp(() => adminDelete(`/admin/variants/${variant.id}`));
      onChanged();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  return (
    <li className="space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="break-all font-semibold">{variant.sku}{variant.name ? ` · ${variant.name}` : ''}</p>
          <p className="text-sm text-[#4A5550]">
            {variant.salePriceMinor !== null ? `${formatPaise(variant.salePriceMinor)} (was ${formatPaise(variant.priceMinor)})` : formatPaise(variant.priceMinor)}
            {' · '}{variant.available} in stock{' · '}{variant.isActive ? 'active' : 'inactive'}
          </p>
        </div>
        <div className="flex gap-2">
          <button type="button" className={adminGhostButton} onClick={() => setOpen((o) => !o)}>{open ? 'Close' : 'Edit'}</button>
          <button type="button" className={adminDangerButton} disabled={busy} onClick={() => void remove()}>Delete</button>
        </div>
      </div>
      {error && <Alert kind="error">{error}</Alert>}
      {open && (
        <form onSubmit={save} className="space-y-3">
          <VariantFields draft={draft} isNew={false} onChange={setDraft} />
          <button className={adminButton} disabled={busy}>{busy ? 'Saving…' : 'Save variant'}</button>
        </form>
      )}
    </li>
  );
}

function VariantsPanel({ product, onChanged }: { product: AdminProduct; onChanged: () => void }) {
  const { withStepUp } = useAdminSession();
  const [draft, setDraft] = useState(emptyVariant);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function add(event: React.FormEvent) {
    event.preventDefault();
    const body = parseVariant(draft, true);
    if (typeof body === 'string') return setError(body);
    setBusy(true);
    setError('');
    try {
      await withStepUp(() => adminPost(`/admin/products/${product.id}/variants`, body));
      setDraft(emptyVariant());
      setAdding(false);
      onChanged();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={adminCard}>
      <div className="flex items-center justify-between gap-3 p-6 pb-4">
        <h2 className="font-heading text-xl font-bold">Variants and pricing</h2>
        <button type="button" className={adminGhostButton} onClick={() => setAdding((a) => !a)}><Plus className="mr-1 inline h-4 w-4" />Add variant</button>
      </div>
      <p className="px-6 pb-4 text-sm text-[#4A5550]">Stock is managed in Inventory, not here.</p>
      {adding && (
        <form onSubmit={add} className="space-y-3 border-t border-[#E6EAE7] p-6">
          <VariantFields draft={draft} isNew onChange={setDraft} />
          {error && <Alert kind="error">{error}</Alert>}
          <button className={adminButton} disabled={busy}>{busy ? 'Adding…' : 'Add variant'}</button>
        </form>
      )}
      <ul className="divide-y divide-[#E6EAE7] border-t border-[#E6EAE7]">
        {product.variants.map((v) => <VariantRow key={`${v.id}:${product.updatedAt}`} variant={v} onChanged={onChanged} />)}
        {product.variants.length === 0 && <li className="p-6 text-sm text-[#4A5550]">No variants yet. A product needs at least one active variant to be published.</li>}
      </ul>
    </section>
  );
}

// -------------------------------------------------------------------------------------------------- images

function ImagesPanel({ product, onChanged }: { product: AdminProduct; onChanged: () => void }) {
  const { withStepUp } = useAdminSession();
  const [alt, setAlt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function upload(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith('image/')) return setError('Choose an image file (JPEG, PNG or WebP).');
    if (file.size > MAX_IMAGE_BYTES) return setError('The image is larger than 5 MB.');
    setBusy(true);
    setError('');
    try {
      await withStepUp(() => {
        const form = new FormData();
        form.set('file', file);
        if (alt.trim()) form.set('altText', alt.trim());
        return adminRequest(`/admin/products/${product.id}/images`, { method: 'POST', body: form });
      });
      setAlt('');
      onChanged();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(imageId: string) {
    if (!window.confirm('Remove this image?')) return;
    setBusy(true);
    setError('');
    try {
      await withStepUp(() => adminDelete(`/admin/images/${imageId}`));
      onChanged();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={`${adminCard} space-y-4 p-6`}>
      <h2 className="font-heading text-xl font-bold">Images</h2>
      {error && <Alert kind="error">{error}</Alert>}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {product.images.map((img) => (
          <figure key={img.id} className="space-y-2">
            {img.url ? (
              // Served by the backend (or CDN); the host differs per environment, so next/image is not used here.
              // eslint-disable-next-line @next/next/no-img-element
              <img src={img.url} alt={img.altText ?? ''} className="aspect-square w-full rounded-xl border border-[#E6EAE7] object-cover" />
            ) : (
              <div className="aspect-square w-full rounded-xl bg-[#F5F6F5]" />
            )}
            <button type="button" className="text-xs font-semibold text-red-700" disabled={busy} onClick={() => void remove(img.id)}>Remove</button>
          </figure>
        ))}
      </div>
      {product.images.length === 0 && <p className="text-sm text-[#4A5550]">No images yet.</p>}
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Alt text (describes the image)">
          <input maxLength={200} className={adminInput} value={alt} onChange={(e) => setAlt(e.target.value)} />
        </Field>
        <label className={`${adminButton} inline-flex cursor-pointer items-center gap-2`}>
          <Upload className="h-4 w-4" /> {busy ? 'Uploading…' : 'Upload image'}
          <input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" disabled={busy} onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
      </div>
      <p className="text-xs text-[#4A5550]">JPEG, PNG or WebP, up to 5 MB.</p>
    </section>
  );
}
