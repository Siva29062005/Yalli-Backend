'use client';

import { useState } from 'react';
import { Search, Tag, Trash2 } from 'lucide-react';
import { useAdminSession } from '@/components/AdminContext';
import { Alert, AdminPage, Field, adminButton, adminCard, adminInput } from '@/components/AdminKit';
import { adminDelete, adminGet, adminPost } from '@/lib/admin-api';
import { categorySlug } from '@/lib/category-utils';
import { useAdminQuery } from '@/lib/useAdminQuery';

interface Brand {
  id: string;
  name: string;
  slug: string;
  _count: { products: number };
}

const errorText = (e: unknown) => (e instanceof Error && e.message ? e.message : 'Something went wrong. Please try again.');

/**
 * Brands. Reading needs products.read; creating products.update; deleting products.delete (the server enforces each).
 * Deleting a brand keeps its products: they simply have no brand afterwards.
 */
export default function AdminBrandsPage() {
  const { withStepUp, can } = useAdminSession();
  const canCreate = can('products.update');
  const canDelete = can('products.delete');
  const list = useAdminQuery(() => adminGet<Brand[]>('/admin/brands'), []);
  const brands = list.data ?? [];
  const [search, setSearch] = useState('');
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function run(call: () => Promise<unknown>, done: string, after?: () => void) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await withStepUp(call);
      after?.();
      setNotice(done);
      list.reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  function create(event: React.FormEvent) {
    event.preventDefault();
    const body = { name: name.trim(), ...(slug.trim() ? { slug: slug.trim() } : {}) };
    void run(() => adminPost('/admin/brands', body), `Brand ${body.name} created.`, () => {
      setName('');
      setSlug('');
      setSlugEdited(false);
    });
  }

  function remove(b: Brand) {
    const warning = b._count.products
      ? `${b._count.products} product${b._count.products === 1 ? '' : 's'} will have no brand afterwards (they stay in the shop).`
      : 'No product uses it.';
    if (!window.confirm(`Delete the brand "${b.name}"? ${warning}`)) return;
    void run(() => adminDelete(`/admin/brands/${b.id}`), `Brand ${b.name} deleted.`);
  }

  const shown = brands.filter((b) => `${b.name} ${b.slug}`.toLowerCase().includes(search.trim().toLowerCase()));

  return (
    <AdminPage eyebrow="Catalogue" title="Brands" subtitle="The makers you sell. A brand with buyable products gets its own page in the shop (/brands/<slug>).">
      {error && <Alert kind="error">{error}</Alert>}
      {list.error && !error && <Alert kind="error">{list.error}</Alert>}
      {notice && <Alert kind="success">{notice}</Alert>}

      <div className={`grid grid-cols-1 items-start gap-6 ${canCreate ? 'xl:grid-cols-[minmax(0,1fr)_340px]' : ''}`}>
        <section className={`${adminCard} min-w-0`}>
          <div className="border-b border-[#E6EAE7] p-4">
            <label className="relative block">
              <span className="sr-only">Search brands</span>
              <Search className="absolute left-3 top-3 h-4 w-4 text-[#4A5550]" />
              <input className={`${adminInput} pl-9`} placeholder="Search brands" value={search} onChange={(e) => setSearch(e.target.value)} />
            </label>
          </div>
          {list.loading && !list.data ? (
            <p role="status" className="p-8 text-sm">Loading brands…</p>
          ) : shown.length === 0 ? (
            <div className="p-10 text-center">
              <Tag className="mx-auto mb-3 text-[#116644]" />
              <h2 className="font-semibold">{brands.length ? 'No matching brands' : 'No brands yet'}</h2>
            </div>
          ) : (
            <ul className="divide-y divide-[#E6EAE7]">
              {shown.map((b) => (
                <li key={b.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
                  <div className="min-w-0">
                    <h2 className="break-all font-semibold">{b.name}</h2>
                    <p className="break-all text-xs text-[#4A5550]">
                      /brands/{b.slug} · {b._count.products} product{b._count.products === 1 ? '' : 's'}
                    </p>
                  </div>
                  {canDelete && (
                    <button type="button" disabled={busy} aria-label={`Delete ${b.name}`} className="rounded-lg border border-red-100 p-2.5 text-red-700 disabled:opacity-30" onClick={() => remove(b)}>
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        {canCreate && (
          <form onSubmit={create} className={`${adminCard} min-w-0 space-y-4 p-5`}>
            <h2 className="text-lg font-bold">Add brand</h2>
            <Field label="Brand name">
              <input
                required
                maxLength={100}
                className={adminInput}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (!slugEdited) setSlug(categorySlug(e.target.value));
                }}
              />
            </Field>
            <Field label="URL slug" hint="Lowercase letters, numbers and single hyphens.">
              <input
                maxLength={120}
                pattern="[a-z0-9]+(-[a-z0-9]+)*"
                className={adminInput}
                value={slug}
                onChange={(e) => {
                  setSlugEdited(true);
                  setSlug(e.target.value);
                }}
              />
            </Field>
            <button className={adminButton} disabled={busy || !name.trim()}>
              {busy ? 'Saving…' : 'Create brand'}
            </button>
            {!canDelete && <p className="text-xs text-[#4A5550]">Deleting a brand needs product delete access.</p>}
          </form>
        )}
      </div>
      {!canCreate && <p className="text-sm text-[#4A5550]">View only: adding brands needs product editing access.</p>}
    </AdminPage>
  );
}
