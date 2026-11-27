'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Plus, Search } from 'lucide-react';
import { Alert, AdminPage, DataState, Pager, Pill, adminButton, adminCard, adminDangerButton, adminGhostButton, adminInput, useClampedPage } from '@/components/AdminKit';
import { useAdminSession } from '@/components/AdminContext';
import { adminDelete, adminList, adminPost } from '@/lib/admin-api';
import { useAdminQuery } from '@/lib/useAdminQuery';
import { formatIndianDate, formatPaise } from '@/lib/formatters';

type ProductStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';

interface AdminProductRow {
  id: string;
  slug: string;
  name: string;
  status: ProductStatus;
  updatedAt: string;
  _count: { variants: number; images: number };
  /** Category names. */
  categories: string[];
  /** Current customer price across the live variants; null when no variant is active. */
  price: { minMinor: number; maxMinor: number; onSale: boolean } | null;
  /** Sellable units across the live variants. */
  stock: { available: number; lowStock: boolean };
}

const STATUS_TONE = { PUBLISHED: 'green', DRAFT: 'amber', ARCHIVED: 'gray' } as const;
const STATUS_LABEL = { PUBLISHED: 'Published', DRAFT: 'Draft', ARCHIVED: 'Archived' } as const;

export default function AdminProductsPage() {
  const { withStepUp, can } = useAdminSession();
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const list = useAdminQuery(() => adminList<AdminProductRow>('/admin/products', { q, status, page, pageSize: 20 }), [q, status, page]);
  useClampedPage(list.data?.meta, page, setPage);

  async function act(row: AdminProductRow, action: 'publish' | 'unpublish' | 'archive' | 'delete') {
    if (action === 'delete' && !window.confirm(`Delete "${row.name}"? It disappears from the shop; past orders keep their record.`)) return;
    if (action === 'archive' && !window.confirm(`Archive "${row.name}"? It is hidden from the shop.`)) return;
    setBusyId(row.id);
    setError('');
    setNotice('');
    try {
      await withStepUp(() => (action === 'delete' ? adminDelete(`/admin/products/${row.id}`) : adminPost(`/admin/products/${row.id}/${action}`)));
      setNotice({
        publish: 'Product published.',
        unpublish: row.status === 'ARCHIVED' ? 'Product restored as a draft.' : 'Product moved back to draft.',
        archive: 'Product archived.',
        delete: 'Product deleted.',
      }[action]);
      list.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update the product.');
    } finally {
      setBusyId(null);
    }
  }

  const rows = list.data?.items ?? [];

  return (
    <AdminPage
      eyebrow="Catalogue"
      title="Products"
      subtitle="Manage your collection, from first draft to everyday favourite."
      actions={
        can('products.create') ? (
          <Link href="/admin/products/new" className={`${adminButton} inline-flex items-center gap-1.5`}>
            <Plus className="h-4 w-4" /> Add product
          </Link>
        ) : undefined
      }
    >
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
          <label className="relative min-w-[220px] flex-1">
            <span className="sr-only">Search by name or SKU</span>
            <Search className="absolute left-3 top-3 h-4 w-4 text-[#4A5550]" />
            <input className={`${adminInput} pl-9`} placeholder="Search by name or SKU" maxLength={100} value={search} onChange={(e) => setSearch(e.target.value)} />
          </label>
          <select
            aria-label="Filter by status"
            className="rounded-xl border border-[#DCE3DE] bg-white p-2 text-sm"
            value={status}
            onChange={(e) => {
              setPage(1);
              setStatus(e.target.value);
            }}
          >
            <option value="">All statuses</option>
            <option value="PUBLISHED">Published</option>
            <option value="DRAFT">Draft</option>
            <option value="ARCHIVED">Archived</option>
          </select>
          <button className={adminGhostButton}>Search</button>
        </form>

        <DataState
          loading={list.loading && !list.data}
          error={list.error}
          empty={rows.length === 0}
          emptyTitle={q || status ? 'No matching products' : 'No products yet'}
          emptyHint={q || status ? 'Try another search or status.' : 'Add your first product. It starts as a draft.'}
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] text-left text-sm">
              <thead className="bg-[#F7F9F8] text-xs uppercase tracking-wide text-[#4A5550]">
                <tr>
                  <th className="p-4">Product</th>
                  <th className="p-4">Category</th>
                  <th className="p-4 text-right">Price</th>
                  <th className="p-4 text-right">Stock</th>
                  <th className="p-4">Status</th>
                  <th className="p-4">Updated</th>
                  <th className="p-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E6EAE7]">
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td className="p-4">
                      <Link href={`/admin/products/${row.id}`} className="break-words font-semibold text-[#113322] hover:underline">
                        {row.name}
                      </Link>
                      <p className="break-all text-xs text-[#4A5550]">{row.slug}</p>
                      <p className="text-xs text-[#4A5550]">
                        {row._count.variants} variant{row._count.variants === 1 ? '' : 's'}
                        {row._count.images === 0 ? <span className="font-semibold text-amber-700"> · no images</span> : ` · ${row._count.images} image${row._count.images === 1 ? '' : 's'}`}
                      </p>
                    </td>
                    <td className="p-4 text-[#4A5550]">{row.categories.length ? row.categories.join(', ') : <span className="text-amber-700">None</span>}</td>
                    <td className="p-4 text-right tabular-nums">
                      {row.price === null ? (
                        <span className="text-amber-700">No live variant</span>
                      ) : (
                        <>
                          {row.price.minMinor === row.price.maxMinor ? formatPaise(row.price.minMinor) : `${formatPaise(row.price.minMinor)} – ${formatPaise(row.price.maxMinor)}`}
                          {row.price.onSale && <span className="mt-1 block"><Pill tone="amber">On sale</Pill></span>}
                        </>
                      )}
                    </td>
                    <td className="p-4 text-right tabular-nums">
                      {row.stock.available}
                      {row.price !== null && (row.stock.available <= 0 ? <span className="mt-1 block"><Pill tone="red">Out of stock</Pill></span> : row.stock.lowStock ? <span className="mt-1 block"><Pill tone="amber">Low</Pill></span> : null)}
                    </td>
                    <td className="p-4"><Pill tone={STATUS_TONE[row.status]}>{STATUS_LABEL[row.status]}</Pill></td>
                    <td className="p-4 whitespace-nowrap">{formatIndianDate(row.updatedAt)}</td>
                    <td className="p-4">
                      <div className="flex flex-wrap justify-end gap-2">
                        <Link href={`/admin/products/${row.id}`} className={adminGhostButton}>{can('products.update') ? 'Edit' : 'View'}</Link>
                        {!can('products.publish') ? null : row.status === 'PUBLISHED' ? (
                          <button className={adminGhostButton} disabled={busyId === row.id} onClick={() => void act(row, 'unpublish')}>Unpublish</button>
                        ) : row.status === 'DRAFT' ? (
                          <button className={adminButton} disabled={busyId === row.id} onClick={() => void act(row, 'publish')}>Publish</button>
                        ) : null}
                        {can('products.publish') && row.status !== 'ARCHIVED' && (
                          <button className={adminGhostButton} disabled={busyId === row.id} onClick={() => void act(row, 'archive')}>Archive</button>
                        )}
                        {can('products.publish') && row.status === 'ARCHIVED' && (
                          <button className={adminGhostButton} disabled={busyId === row.id} onClick={() => void act(row, 'unpublish')}>Restore</button>
                        )}
                        {can('products.delete') && (
                          <button className={adminDangerButton} disabled={busyId === row.id} onClick={() => void act(row, 'delete')}>Delete</button>
                        )}
                      </div>
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
