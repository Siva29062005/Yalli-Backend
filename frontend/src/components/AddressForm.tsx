"use client";

import React, { useState } from "react";
import { ApiError } from "@/lib/http";
import { AddressInput, checkoutErrorMessage, INDIAN_STATES, SavedAddress } from "@/lib/checkout-api";
import { accountApi } from "@/lib/account-api";

const input =
  "w-full min-w-0 rounded-xl border border-[#D5DDD8] bg-white px-3.5 py-2.5 text-[14px] text-[#113322] focus:border-[#116644] focus:outline-none focus:ring-2 focus:ring-[#116644]/20";

type FieldErrors = Partial<Record<keyof AddressInput, string>>;

/** Mirrors the backend rules so most mistakes are caught before a round trip; the server validates again. */
export function validateAddress(v: AddressInput): FieldErrors {
  const e: FieldErrors = {};
  if (!v.fullName.trim()) e.fullName = "Enter the recipient’s name";
  if (!/^(\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}$/.test(v.phone.trim())) e.phone = "Enter a valid 10-digit mobile number";
  if (!v.line1.trim()) e.line1 = "Enter the house number and street";
  if (!v.city.trim()) e.city = "Enter the city";
  if (!v.state) e.state = "Choose a state";
  if (!/^[1-9][0-9]{5}$/.test(v.postalCode.trim())) e.postalCode = "Enter a valid 6-digit PIN code";
  return e;
}

function fromSaved(a: SavedAddress): AddressInput {
  return {
    fullName: a.fullName,
    phone: a.phoneE164.replace(/^\+91/, ""),
    line1: a.line1,
    line2: a.line2 ?? "",
    landmark: a.landmark ?? "",
    city: a.city,
    state: a.state,
    postalCode: a.postalCode,
    label: a.label ?? "",
    isDefault: a.isDefault,
  };
}

export function AddressForm({
  onSaved,
  onCancel,
  cancellable,
  makeDefault = false,
  existing,
  submitLabel,
}: {
  onSaved: (a: SavedAddress) => void;
  onCancel: () => void;
  cancellable: boolean;
  makeDefault?: boolean;
  /** When set, the form edits this address instead of creating one. */
  existing?: SavedAddress;
  submitLabel?: string;
}) {
  const [v, setV] = useState<AddressInput>(
    existing
      ? fromSaved(existing)
      : { fullName: "", phone: "", line1: "", line2: "", landmark: "", city: "", state: "", postalCode: "", label: "", isDefault: makeDefault },
  );
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (k: keyof AddressInput) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setV((s) => ({ ...s, [k]: e.target.type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value }));
  const idp = existing ? `addr-${existing.id.slice(0, 8)}` : "addr";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const errs = validateAddress(v);
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setSaving(true);
    setFormError(null);
    try {
      if (existing) {
        // A blank optional field is sent as "" and the backend clears it.
        const body = Object.fromEntries(
          Object.entries(v).map(([k, val]) => [k, typeof val === "string" ? val.trim() : val]),
        ) as Partial<AddressInput>;
        if (existing.isDefault) delete body.isDefault; // un-defaulting is done by choosing another default
        onSaved(await accountApi.updateAddress(existing.id, body));
      } else {
        const clean = Object.fromEntries(
          Object.entries(v).map(([k, val]) => [k, typeof val === "string" ? val.trim() || undefined : val]),
        ) as unknown as AddressInput;
        onSaved(await accountApi.createAddress(clean));
      }
    } catch (err) {
      if (err instanceof ApiError && Array.isArray(err.details)) {
        const fe: FieldErrors = {};
        for (const d of err.details as { path?: (string | number)[]; message?: string }[]) {
          const k = d.path?.[0] as keyof AddressInput | undefined;
          if (k) fe[k] = d.message;
        }
        setErrors(fe);
      }
      setFormError(checkoutErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const field = (k: keyof AddressInput, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}, span = false) => (
    <div className={span ? "sm:col-span-2" : ""}>
      <label htmlFor={`${idp}-${k}`} className="mb-1 block text-[13px] font-medium text-[#113322]">{label}</label>
      <input
        id={`${idp}-${k}`}
        className={input}
        value={(v[k] as string) ?? ""}
        onChange={set(k)}
        aria-invalid={!!errors[k]}
        aria-describedby={errors[k] ? `${idp}-${k}-err` : undefined}
        {...props}
      />
      {errors[k] && <p id={`${idp}-${k}-err`} className="mt-1 text-[12px] text-[#B42318]">{errors[k]}</p>}
    </div>
  );

  return (
    <form onSubmit={submit} noValidate className="rounded-xl border border-dashed border-[#B9CCC1] p-4 space-y-4" aria-label={existing ? "Edit address" : "New address"}>
      <div className="grid gap-4 sm:grid-cols-2">
        {field("fullName", "Full name", { autoComplete: "name" })}
        {field("phone", "Mobile number", { autoComplete: "tel", inputMode: "tel", placeholder: "98765 43210" })}
        {field("line1", "House no., building, street", { autoComplete: "address-line1" }, true)}
        {field("line2", "Area / locality (optional)", { autoComplete: "address-line2" }, true)}
        {field("landmark", "Landmark (optional)")}
        {field("city", "City", { autoComplete: "address-level2" })}
        <div>
          <label htmlFor={`${idp}-state`} className="mb-1 block text-[13px] font-medium text-[#113322]">State</label>
          <select id={`${idp}-state`} className={input} value={v.state} onChange={set("state")} aria-invalid={!!errors.state} autoComplete="address-level1">
            <option value="">Select state</option>
            {INDIAN_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          {errors.state && <p className="mt-1 text-[12px] text-[#B42318]">{errors.state}</p>}
        </div>
        {field("postalCode", "PIN code", { autoComplete: "postal-code", inputMode: "numeric", maxLength: 6 })}
        {field("label", "Label (optional)", { placeholder: "Home, Work…", maxLength: 40 })}
      </div>
      {!existing?.isDefault && (
        <label className="flex items-center gap-2 text-[14px] text-[#113322]">
          <input type="checkbox" checked={!!v.isDefault} onChange={set("isDefault")} className="accent-[#116644]" /> Make this my default address
        </label>
      )}
      {formError && <p role="alert" className="text-[13px] text-[#B42318]">{formError}</p>}
      <div className="flex flex-wrap gap-3">
        <button type="submit" disabled={saving} className="rounded-xl bg-[#116644] px-5 py-2.5 text-[14px] font-semibold text-white disabled:opacity-50">
          {saving ? "Saving…" : submitLabel ?? (existing ? "Save address" : "Save address")}
        </button>
        {cancellable && (
          <button type="button" onClick={onCancel} className="rounded-xl border border-[#D5DDD8] px-5 py-2.5 text-[14px] font-semibold text-[#113322]">
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
