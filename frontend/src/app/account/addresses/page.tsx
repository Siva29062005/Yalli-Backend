"use client";

import React, { useState } from "react";
import { Plus, Pencil, Trash2, Star } from "lucide-react";
import { AccountShell, PanelEmpty, PanelError, PanelLoading, secondaryButton } from "@/components/AccountShell";
import { AddressForm } from "@/components/AddressForm";
import { accountApi } from "@/lib/account-api";
import { formatPhone, type SavedAddress } from "@/lib/checkout-api";
import { useAsync } from "@/lib/useAsync";

/** Default first, then newest-created order the API returned. */
const sorted = (list: SavedAddress[]) => [...list].sort((a, b) => Number(b.isDefault) - Number(a.isDefault));

export default function AddressesPage() {
  const { data, setData, error, loading, reload } = useAsync(() => accountApi.addresses(), []);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const upsert = (a: SavedAddress) =>
    setData((list) => {
      const rest = (list ?? []).filter((x) => x.id !== a.id).map((x) => (a.isDefault ? { ...x, isDefault: false } : x));
      return [...rest, a];
    });

  const run = async (id: string, fn: () => Promise<void>) => {
    setBusy(id);
    setActionError(null);
    try {
      await fn();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  };

  const makeDefault = (a: SavedAddress) =>
    run(a.id, async () => {
      upsert(await accountApi.setDefaultAddress(a.id));
    });

  const remove = (a: SavedAddress) => {
    if (!window.confirm(`Delete the address for ${a.fullName}?`)) return;
    void run(a.id, async () => {
      await accountApi.removeAddress(a.id);
      // The backend promotes another address when the default is removed, so reload for the truth.
      setData((list) => (list ?? []).filter((x) => x.id !== a.id));
      if (a.isDefault) reload();
    });
  };

  const list = data ? sorted(data) : [];

  return (
    <AccountShell
      title="Saved addresses"
      subtitle="Where should we send your goodies?"
      crumbs={[{ label: "Addresses" }]}
      actions={
        data && data.length > 0 && !adding ? (
          <button type="button" className={secondaryButton} onClick={() => { setAdding(true); setEditing(null); }}>
            <Plus className="h-4 w-4" /> Add address
          </button>
        ) : undefined
      }
    >
      {actionError && <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-[13px] text-red-700">{actionError}</p>}
      {loading && !data ? (
        <PanelLoading label="Loading your addresses…" />
      ) : error ? (
        <PanelError message={error} onRetry={reload} />
      ) : (
        <div className="space-y-4">
          {(adding || list.length === 0) && (
            <div className="rounded-3xl border border-[#E6EAE7] bg-white p-5 md:p-6 space-y-3">
              <h2 className="font-heading text-[18px] font-bold text-[#113322]">{list.length === 0 ? "Add your first address" : "New address"}</h2>
              <AddressForm
                cancellable={list.length > 0}
                makeDefault={list.length === 0}
                onCancel={() => setAdding(false)}
                onSaved={(a) => {
                  upsert(a);
                  setAdding(false);
                }}
              />
            </div>
          )}
          {list.length === 0 && !adding && (
            <PanelEmpty title="No saved addresses" body="Add one above and it’ll be ready at checkout." />
          )}
          <ul className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            {list.map((a) => (
              <li key={a.id} className={`rounded-3xl border bg-white p-5 space-y-3 min-w-0 ${a.isDefault ? "border-[#116644]/40" : "border-[#E6EAE7]"}`}>
                {editing === a.id ? (
                  <AddressForm
                    existing={a}
                    cancellable
                    onCancel={() => setEditing(null)}
                    onSaved={(x) => {
                      upsert(x);
                      setEditing(null);
                    }}
                  />
                ) : (
                  <>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-heading text-[16px] font-bold text-[#113322] break-words min-w-0">{a.fullName}</span>
                      {a.label && <span className="rounded-full bg-[#F2F5F3] px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-[#4A5550]">{a.label}</span>}
                      {a.isDefault && <span className="rounded-full bg-[#E0EFE5] px-2.5 py-0.5 text-[11px] font-semibold text-[#116644]">Default</span>}
                    </div>
                    <p className="text-[14px] text-[#4A5550] break-words">
                      {[a.line1, a.line2, a.landmark].filter(Boolean).join(", ")}
                      <br />
                      {a.city}, {a.state} {a.postalCode}
                    </p>
                    <p className="text-[13px] text-[#8A958E]">{formatPhone(a.phoneE164)}</p>
                    <div className="flex flex-wrap gap-2 pt-1">
                      <button type="button" className={secondaryButton} disabled={busy === a.id} onClick={() => { setEditing(a.id); setAdding(false); }}>
                        <Pencil className="h-3.5 w-3.5" /> Edit
                      </button>
                      {!a.isDefault && (
                        <button type="button" className={secondaryButton} disabled={busy === a.id} onClick={() => makeDefault(a)}>
                          <Star className="h-3.5 w-3.5" /> Make default
                        </button>
                      )}
                      <button type="button" className={`${secondaryButton} hover:!border-red-200 hover:text-red-600`} disabled={busy === a.id} onClick={() => remove(a)} aria-label={`Delete address for ${a.fullName}`}>
                        <Trash2 className="h-3.5 w-3.5" /> Delete
                      </button>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </AccountShell>
  );
}
