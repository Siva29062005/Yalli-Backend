'use client';

import { useEffect, useRef, useState } from 'react';
import { FolderTree, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { useAdminSession } from '@/components/AdminContext';
import { Alert, AdminPage, Field, Pill, adminButton, adminCard, adminDangerButton, adminGhostButton, adminInput } from '@/components/AdminKit';
import { useCategories } from '@/components/CategoryProvider';
import { adminDelete, adminGet, adminPatch, adminPost } from '@/lib/admin-api';
import { canDeleteCategory, categorySlug, parentOptions, type AdminCategory } from '@/lib/category-utils';
import { useAdminQuery } from '@/lib/useAdminQuery';

const emptyForm = { name: '', slug: '', parentId: '', position: 0, isActive: true };
const errorText = (e: unknown) => (e instanceof Error && e.message ? e.message : 'Something went wrong. Please try again.');

/**
 * Categories. Reading needs products.read (the screen gate); creating and editing need products.update, deleting
 * products.delete. Every call goes through withStepUp, so a step-up challenge shows the shared prompt and retries.
 */
export default function CategoriesPage() {
  const { refresh } = useCategories();
  const { withStepUp, can } = useAdminSession();
  const canManage = can('products.update');
  const canDelete = can('products.delete');
  const list = useAdminQuery(() => adminGet<AdminCategory[]>('/admin/categories'), []);
  const categories = list.data ?? [];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [editing, setEditing] = useState<AdminCategory | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [slugEdited, setSlugEdited] = useState(false);
  const [deleting, setDeleting] = useState<AdminCategory | null>(null);
  const [deleteName, setDeleteName] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const editor = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (deleting) dialog.current?.showModal();
    else dialog.current?.close();
  }, [deleting]);

  const resetForm = () => {
    setEditing(null);
    setForm(emptyForm);
    setSlugEdited(false);
  };

  async function mutate(call: () => Promise<unknown>, done: string, after?: () => void) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await withStepUp(call);
      after?.();
      setNotice(done);
      list.reload();
      void refresh(); // the storefront menu
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  function save(event: React.FormEvent) {
    event.preventDefault();
    const payload = { ...form, name: form.name.trim(), slug: form.slug.trim(), parentId: form.parentId || null };
    void mutate(
      () => (editing ? adminPatch(`/admin/categories/${editing.id}`, payload) : adminPost('/admin/categories', payload)),
      editing ? 'Category updated.' : 'Category created.',
      resetForm,
    );
  }

  function remove() {
    const target = deleting;
    if (!target || deleteName !== target.name) return;
    setDeleting(null);
    void mutate(() => adminDelete(`/admin/categories/${target.id}`), 'Category deleted.', () => {
      setDeleteName('');
      if (editing?.id === target.id) resetForm();
    });
  }

  const filtered = categories.filter(
    (c) =>
      `${c.name} ${c.slug}`.toLowerCase().includes(search.toLowerCase()) &&
      (status === 'all' || c.isActive === (status === 'active')),
  );

  return (
    <AdminPage
      eyebrow="Catalogue / Collections"
      title="Categories"
      subtitle="Organise your store, your way. Create collections, arrange subcategories, and choose what customers see."
    >
      {error && <Alert kind="error">{error}</Alert>}
      {list.error && !error && <Alert kind="error">{list.error}</Alert>}
      {notice && <Alert kind="success">{notice}</Alert>}
      {!canManage && <Alert kind="warning">You can view categories. Changing them needs product editing access.</Alert>}

      <div className="grid grid-cols-3 gap-3">
        {[
          ['Total', categories.length],
          ['Visible', categories.filter((c) => c.isActive).length],
          ['Hidden', categories.filter((c) => !c.isActive).length],
        ].map(([label, count]) => (
          <div key={label} className="rounded-2xl border border-[#E6EAE7] bg-white p-4">
            <p className="text-xs text-[#4A5550]">{label}</p>
            <p className="mt-1 text-2xl font-bold">{count}</p>
          </div>
        ))}
      </div>

      <div className={`grid grid-cols-1 items-start gap-6 ${canManage ? 'xl:grid-cols-[minmax(0,1fr)_360px]' : ''}`}>
        <section className={`${adminCard} min-w-0`}>
          <div className="flex flex-wrap gap-3 border-b border-[#E6EAE7] p-4">
            <label className="relative min-w-0 flex-1">
              <span className="sr-only">Search categories</span>
              <Search className="absolute left-3 top-3 h-4 w-4 text-[#4A5550]" />
              <input className={`${adminInput} pl-9`} placeholder="Search categories" value={search} onChange={(e) => setSearch(e.target.value)} />
            </label>
            <select aria-label="Filter visibility" className="max-w-full rounded-xl border border-[#DCE3DE] p-2 text-sm" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="all">All statuses</option>
              <option value="active">Visible</option>
              <option value="hidden">Hidden</option>
            </select>
            <button
              type="button"
              disabled={list.loading || busy}
              className="text-sm font-semibold text-[#116644]"
              onClick={() => {
                setError('');
                list.reload();
              }}
            >
              Refresh
            </button>
          </div>
          {list.loading && !list.data ? (
            <p role="status" className="p-8 text-sm">Loading categories…</p>
          ) : filtered.length === 0 ? (
            <div className="p-10 text-center">
              <FolderTree className="mx-auto mb-3 text-[#116644]" />
              <h2 className="font-semibold">{categories.length ? 'No matching categories' : 'Start your first collection'}</h2>
              <p className="mt-2 text-sm text-[#4A5550]">
                {categories.length ? 'Try another search or visibility filter.' : 'Add a category using the form. It will appear in your storefront.'}
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-[#E6EAE7]">
              {filtered.map((category) => (
                <li key={category.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="break-all font-semibold">{category.name}</h2>
                      <Pill tone={category.isActive ? 'green' : 'gray'}>{category.isActive ? 'Visible' : 'Hidden'}</Pill>
                    </div>
                    <p className="mt-1 break-all text-xs text-[#4A5550]">
                      /{category.slug} · {category._count.products} products · Position {category.position}
                    </p>
                    {category.parentId && (
                      <p className="mt-1 break-all text-xs text-[#4A5550]">
                        Under {categories.find((c) => c.id === category.parentId)?.name ?? 'another category'}
                      </p>
                    )}
                  </div>
                  {(canManage || canDelete) && (
                    <div className="flex gap-2">
                      {canManage && (
                      <button
                        type="button"
                        disabled={busy}
                        aria-label={`Edit ${category.name}`}
                        className="rounded-lg border border-[#E6EAE7] p-2.5 hover:bg-[#EEFFEE]"
                        onClick={() => {
                          setEditing(category);
                          setSlugEdited(true);
                          setForm({
                            name: category.name,
                            slug: category.slug,
                            parentId: category.parentId ?? '',
                            position: category.position,
                            isActive: category.isActive,
                          });
                          editor.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                        }}
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      )}
                      {canDelete && (
                        <button
                          type="button"
                          disabled={busy || !canDeleteCategory(category)}
                          aria-label={`Delete ${category.name}`}
                          title={canDeleteCategory(category) ? 'Delete empty category' : 'Move products and subcategories first, or hide this category'}
                          className="rounded-lg border border-red-100 p-2.5 text-red-700 disabled:cursor-not-allowed disabled:opacity-30"
                          onClick={() => {
                            setDeleting(category);
                            setDeleteName('');
                          }}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        {canManage && (
          <form ref={editor} onSubmit={save} className={`${adminCard} min-w-0 scroll-mt-6 space-y-4 p-5`}>
            <h2 className="flex items-center gap-2 text-lg font-bold">
              <Plus className="h-5 w-5 text-[#116644]" />
              {editing ? 'Edit category' : 'Add category'}
            </h2>
            <Field label="Category name">
              <input
                className={adminInput}
                required
                maxLength={100}
                value={form.name}
                onChange={(e) => {
                  const name = e.target.value;
                  setForm({ ...form, name, ...(!slugEdited ? { slug: categorySlug(name) } : {}) });
                }}
              />
            </Field>
            <Field label="URL slug">
              <input
                className={adminInput}
                required
                maxLength={120}
                pattern="[a-z0-9]+(-[a-z0-9]+)*"
                title="Lowercase letters, numbers, and single hyphens"
                value={form.slug}
                onChange={(e) => {
                  setSlugEdited(true);
                  setForm({ ...form, slug: e.target.value });
                }}
              />
            </Field>
            {editing && <p className="text-xs text-amber-800">Changing the URL can break existing bookmarks and links.</p>}
            <Field label="Parent category">
              <select className={adminInput} value={form.parentId} onChange={(e) => setForm({ ...form, parentId: e.target.value })}>
                <option value="">None — top level</option>
                {parentOptions(categories, editing?.id).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.isActive ? '' : ' (hidden)'}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Display position" hint="Lower numbers appear first. Names break ties.">
              <input
                className={adminInput}
                type="number"
                required
                min={0}
                max={1000}
                step={1}
                value={form.position}
                onChange={(e) => setForm({ ...form, position: Number(e.target.value) })}
              />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />
              Visible in storefront
            </label>
            <p className="text-xs text-[#4A5550]">Hiding a parent also hides its subcategories in navigation. Products are not deleted.</p>
            <div className="flex flex-wrap gap-3">
              <button className={adminButton} disabled={busy || (list.loading && !list.data)}>
                {busy ? 'Saving…' : editing ? 'Save changes' : 'Create category'}
              </button>
              {editing && (
                <button type="button" className="text-sm underline" onClick={resetForm}>
                  Cancel edit
                </button>
              )}
            </div>
            <p className="text-xs leading-relaxed text-[#4A5550]">
              Only empty categories can be permanently deleted. Hide a category to remove it from navigation without losing its products.
            </p>
          </form>
        )}
      </div>

      <dialog
        ref={dialog}
        onCancel={() => setDeleting(null)}
        className="fixed inset-0 m-auto w-[calc(100%-2rem)] max-w-md rounded-2xl border border-[#E6EAE7] bg-white p-6 text-[#113322] shadow-xl backdrop:bg-black/40"
      >
        <h2 className="text-xl font-bold">Delete category?</h2>
        <p className="mt-3 break-words text-sm">This permanently deletes “{deleting?.name}”. This action cannot be undone.</p>
        <label className="mt-4 block text-sm">
          Type the category name to confirm
          <input className={`${adminInput} mt-2`} value={deleteName} onChange={(e) => setDeleteName(e.target.value)} />
        </label>
        <div className="mt-5 flex gap-3">
          <button type="button" disabled={busy || deleteName !== deleting?.name} onClick={remove} className={adminDangerButton}>
            Delete permanently
          </button>
          <button type="button" onClick={() => setDeleting(null)} className={adminGhostButton}>
            Cancel
          </button>
        </div>
      </dialog>
    </AdminPage>
  );
}
