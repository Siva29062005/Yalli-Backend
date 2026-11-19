'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { FolderTree, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { AdminSidebar } from '@/components/AdminSidebar';
import { useAdminSession } from '@/components/AdminContext';
import { useCategories } from '@/components/CategoryProvider';
import {
  adminRequest,
  adminStepUp,
} from '@/lib/admin-session';
import { ApiError } from '@/lib/http';
import {
  canDeleteCategory,
  categorySlug,
  parentOptions,
  type AdminCategory,
} from '@/lib/category-utils';

const inputClass =
  'w-full max-w-full min-w-0 rounded-xl border border-[#DCE3DE] bg-white px-3 py-2.5 text-sm';
const buttonClass =
  'rounded-xl bg-[#116644] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50';
const emptyForm = {
  name: '',
  slug: '',
  parentId: '',
  position: 0,
  isActive: true,
};

export default function CategoriesPage() {
  const { refresh } = useCategories();
  const { identity, signOut, can } = useAdminSession();
  // Reading is gated by the screen itself (products.read); changing needs products.update, deleting products.delete.
  const canManage = can('products.update');
  const [categories, setCategories] = useState<AdminCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [stepUp, setStepUp] = useState(false);
  const [code, setCode] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [editing, setEditing] = useState<AdminCategory | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [slugEdited, setSlugEdited] = useState(false);
  const [deleting, setDeleting] = useState<AdminCategory | null>(null);
  const [deleteName, setDeleteName] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const editor = useRef<HTMLFormElement>(null);

  const handleError = useCallback((error: unknown) => {
    if (error instanceof ApiError && error.code === 'STEP_UP_REQUIRED')
      setStepUp(true);
    setError(
      error instanceof Error
        ? error.message
        : 'Something went wrong. Please try again.',
    );
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setCategories(await adminRequest<AdminCategory[]>('/admin/categories'));
    } catch (error) {
      handleError(error);
    } finally {
      setLoading(false);
    }
  }, [handleError]);

  useEffect(() => {
    if (deleting) dialog.current?.showModal();
    else dialog.current?.close();
  }, [deleting]);

  useEffect(() => {
    if (!canManage) return;
    const controller = new AbortController();
    void adminRequest<AdminCategory[]>('/admin/categories', { signal: controller.signal })
      .then(setCategories)
      .catch((error: unknown) => {
        if (!controller.signal.aborted) handleError(error);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [canManage, handleError]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const payload = {
        ...form,
        name: form.name.trim(),
        slug: form.slug.trim(),
        parentId: form.parentId || null,
      };
      await adminRequest(
        editing ? `/admin/categories/${editing.id}` : '/admin/categories',
        {
          method: editing ? 'PATCH' : 'POST',
          body: JSON.stringify(payload),
        },
      );
      setNotice(editing ? 'Category updated.' : 'Category created.');
      setEditing(null);
      setForm(emptyForm);
      setSlugEdited(false);
      await Promise.all([load(), refresh()]);
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!deleting || deleteName !== deleting.name) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await adminRequest(`/admin/categories/${deleting.id}`, {
        method: 'DELETE',
      });
      setDeleting(null);
      setDeleteName('');
      setNotice('Category deleted.');
      if (editing?.id === deleting.id) {
        setEditing(null);
        setForm(emptyForm);
      }
      await Promise.all([load(), refresh()]);
    } catch (error) {
      setDeleting(null);
      handleError(error);
    } finally {
      setBusy(false);
    }
  }

  const canDelete = can('products.delete');
  const filtered = categories.filter(
    (category) =>
      `${category.name} ${category.slug}`
        .toLowerCase()
        .includes(search.toLowerCase()) &&
      (status === 'all' || category.isActive === (status === 'active')),
  );

  return (
    <div className="flex min-h-screen flex-col bg-[#F7F9F8] md:flex-row">
      <AdminSidebar />
      <main className="min-w-0 flex-1 space-y-6 p-4 md:p-8 lg:p-10">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-[#116644]">
              Catalogue / Collections
            </p>
            <h1 className="font-heading text-3xl font-bold">Categories</h1>
            <p className="mt-2 max-w-xl text-sm text-[#4A5550]">
              Organise your store, your way. Create collections, arrange
              subcategories, and choose what customers see.
            </p>
          </div>
          {identity && (
            <div className="text-sm">
              <p className="break-all">{identity.email}</p>
              <button
                type="button"
                className="mt-2 font-semibold text-[#116644] underline"
                onClick={() => void signOut()}
              >
                Sign out
              </button>
            </div>
          )}
        </header>
        {error && (
          <div
            role="alert"
            className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800"
          >
            {error}
          </div>
        )}
        {notice && (
          <div
            role="status"
            className="rounded-xl border border-green-200 bg-green-50 p-4 text-sm text-green-800"
          >
            {notice}
          </div>
        )}

        {!canManage ? (
          <section role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm">
            Your staff role does not have category management access. Choose an authorised workspace from the sidebar.
          </section>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-3">
              {[
                ['Total', categories.length],
                ['Visible', categories.filter((c) => c.isActive).length],
                ['Hidden', categories.filter((c) => !c.isActive).length],
              ].map(([label, count]) => (
                <div
                  key={label}
                  className="rounded-2xl border border-[#E6EAE7] bg-white p-4"
                >
                  <p className="text-xs text-[#4A5550]">{label}</p>
                  <p className="mt-1 text-2xl font-bold">{count}</p>
                </div>
              ))}
            </div>
            {stepUp && (
              <form
                className="flex flex-wrap items-end gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4"
                onSubmit={async (event) => {
                  event.preventDefault();
                  setBusy(true);
                  try {
                    await adminStepUp(code);
                    setCode('');
                    setStepUp(false);
                    setError('');
                    await load();
                    setNotice('Verified. You can retry your change.');
                  } catch (error) {
                    handleError(error);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <label className="text-sm">
                  Confirm your authenticator code
                  <input
                    className={`${inputClass} mt-1`}
                    required
                    inputMode="numeric"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                  />
                </label>
                <button className={buttonClass} disabled={busy}>
                  Verify
                </button>
              </form>
            )}
            <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
              <section className="min-w-0 rounded-2xl border border-[#E6EAE7] bg-white shadow-sm">
                <div className="flex flex-wrap gap-3 border-b border-[#E6EAE7] p-4">
                  <label className="relative min-w-0 flex-1">
                    <span className="sr-only">Search categories</span>
                    <Search className="absolute left-3 top-3 h-4 w-4 text-[#4A5550]" />
                    <input
                      className={`${inputClass} pl-9`}
                      placeholder="Search categories"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                    />
                  </label>
                  <select
                    aria-label="Filter visibility"
                    className="max-w-full rounded-xl border border-[#DCE3DE] p-2 text-sm"
                    value={status}
                    onChange={(event) => setStatus(event.target.value)}
                  >
                    <option value="all">All statuses</option>
                    <option value="active">Visible</option>
                    <option value="hidden">Hidden</option>
                  </select>
                  <button
                    type="button"
                    disabled={loading || busy}
                    className="text-sm font-semibold text-[#116644]"
                    onClick={() => void load()}
                  >
                    Refresh
                  </button>
                </div>
                {loading ? (
                  <p role="status" className="p-8 text-sm">
                    Loading categories…
                  </p>
                ) : filtered.length === 0 ? (
                  <div className="p-10 text-center">
                    <FolderTree className="mx-auto mb-3 text-[#116644]" />
                    <h2 className="font-semibold">
                      {categories.length
                        ? 'No matching categories'
                        : 'Start your first collection'}
                    </h2>
                    <p className="mt-2 text-sm text-[#4A5550]">
                      {categories.length
                        ? 'Try another search or visibility filter.'
                        : 'Add a category using the form. It will appear in your storefront.'}
                    </p>
                  </div>
                ) : (
                  <ul className="divide-y divide-[#E6EAE7]">
                    {filtered.map((category) => (
                      <li
                        key={category.id}
                        className="flex flex-wrap items-center justify-between gap-3 p-4"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <h2 className="break-all font-semibold">
                              {category.name}
                            </h2>
                            <span
                              className={`rounded-full px-2 py-1 text-[11px] font-semibold ${category.isActive ? 'bg-[#EEFFEE] text-[#116644]' : 'bg-gray-100 text-gray-600'}`}
                            >
                              {category.isActive ? 'Visible' : 'Hidden'}
                            </span>
                          </div>
                          <p className="mt-1 break-all text-xs text-[#4A5550]">
                            /{category.slug} · {category._count.products}{' '}
                            products · Position {category.position}
                          </p>
                          {category.parentId && (
                            <p className="mt-1 break-all text-xs text-[#4A5550]">
                              Under{' '}
                              {categories.find(
                                (c) => c.id === category.parentId,
                              )?.name ?? 'another category'}
                            </p>
                          )}
                        </div>
                        <div className="flex gap-2">
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
                              editor.current?.scrollIntoView({
                                behavior: 'smooth',
                                block: 'start',
                              });
                            }}
                          >
                            <Pencil className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            disabled={
                              busy || !canDelete || !canDeleteCategory(category)
                            }
                            aria-label={`Delete ${category.name}`}
                            title={
                              !canDelete
                                ? 'Administrator permission required'
                                : !canDeleteCategory(category)
                                  ? 'Move products and subcategories first, or hide this category'
                                  : 'Delete empty category'
                            }
                            className="rounded-lg border border-red-100 p-2.5 text-red-700 disabled:cursor-not-allowed disabled:opacity-30"
                            onClick={() => {
                              setDeleting(category);
                              setDeleteName('');
                            }}
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <form
                ref={editor}
                onSubmit={save}
                className="min-w-0 scroll-mt-6 space-y-4 rounded-2xl border border-[#E6EAE7] bg-white p-5 shadow-sm"
              >
                <h2 className="flex items-center gap-2 text-lg font-bold">
                  <Plus className="h-5 w-5 text-[#116644]" />
                  {editing ? 'Edit category' : 'Add category'}
                </h2>
                <label className="block text-sm font-medium">
                  Category name
                  <input
                    className={`${inputClass} mt-1`}
                    required
                    maxLength={100}
                    value={form.name}
                    onChange={(event) => {
                      const name = event.target.value;
                      setForm({
                        ...form,
                        name,
                        ...(!slugEdited ? { slug: categorySlug(name) } : {}),
                      });
                    }}
                  />
                </label>
                <label className="block text-sm font-medium">
                  URL slug
                  <input
                    className={`${inputClass} mt-1`}
                    required
                    maxLength={120}
                    pattern="[a-z0-9]+(-[a-z0-9]+)*"
                    title="Lowercase letters, numbers, and single hyphens"
                    value={form.slug}
                    onChange={(event) => {
                      setSlugEdited(true);
                      setForm({ ...form, slug: event.target.value });
                    }}
                  />
                </label>
                {editing && (
                  <p className="text-xs text-amber-800">
                    Changing the URL can break existing bookmarks and links.
                  </p>
                )}
                <label className="block text-sm font-medium">
                  Parent category
                  <select
                    className={`${inputClass} mt-1`}
                    value={form.parentId}
                    onChange={(event) =>
                      setForm({ ...form, parentId: event.target.value })
                    }
                  >
                    <option value="">None — top level</option>
                    {parentOptions(categories, editing?.id).map((category) => (
                      <option key={category.id} value={category.id}>
                        {category.name}
                        {category.isActive ? '' : ' (hidden)'}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm font-medium">
                  Display position
                  <input
                    className={`${inputClass} mt-1`}
                    type="number"
                    required
                    min={0}
                    max={1000}
                    step={1}
                    value={form.position}
                    onChange={(event) =>
                      setForm({ ...form, position: Number(event.target.value) })
                    }
                  />
                </label>
                <p className="text-xs text-[#4A5550]">
                  Lower numbers appear first. Names break ties.
                </p>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={form.isActive}
                    onChange={(event) =>
                      setForm({ ...form, isActive: event.target.checked })
                    }
                  />
                  Visible in storefront
                </label>
                <p className="text-xs text-[#4A5550]">
                  Hiding a parent also hides its subcategories in navigation.
                  Products are not deleted.
                </p>
                <div className="flex flex-wrap gap-3">
                  <button
                    className={buttonClass}
                    disabled={busy || loading || stepUp}
                  >
                    {busy
                      ? 'Saving…'
                      : editing
                        ? 'Save changes'
                        : 'Create category'}
                  </button>
                  {editing && (
                    <button
                      type="button"
                      className="text-sm underline"
                      onClick={() => {
                        setEditing(null);
                        setForm(emptyForm);
                        setSlugEdited(false);
                      }}
                    >
                      Cancel edit
                    </button>
                  )}
                </div>
                <p className="text-xs leading-relaxed text-[#4A5550]">
                  Only empty categories can be permanently deleted. Hide a
                  category to remove it from navigation without losing its
                  products.
                </p>
              </form>
            </div>
          </>
        )}
        <dialog
          ref={dialog}
          onCancel={() => {
            if (!busy) setDeleting(null);
          }}
          className="fixed inset-0 m-auto w-[calc(100%-2rem)] max-w-md rounded-2xl border border-[#E6EAE7] bg-white p-6 text-[#113322] shadow-xl backdrop:bg-black/40"
        >
          <h2 className="text-xl font-bold">Delete category?</h2>
          <p className="mt-3 break-words text-sm">
            This permanently deletes “{deleting?.name}”. This action cannot be
            undone.
          </p>
          <label className="mt-4 block text-sm">
            Type the category name to confirm
            <input
              className={`${inputClass} mt-2`}
              value={deleteName}
              onChange={(event) => setDeleteName(event.target.value)}
            />
          </label>
          <div className="mt-5 flex gap-3">
            <button
              type="button"
              disabled={busy || deleteName !== deleting?.name}
              onClick={() => void remove()}
              className="rounded-xl bg-red-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {busy ? 'Deleting…' : 'Delete permanently'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setDeleting(null)}
              className="text-sm underline"
            >
              Cancel
            </button>
          </div>
        </dialog>
      </main>
    </div>
  );
}
