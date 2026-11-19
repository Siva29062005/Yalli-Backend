"use client";

import React, { useState } from "react";
import Link from "next/link";
import { Check, ShieldCheck, ShieldAlert } from "lucide-react";
import { AccountShell, inputClass, primaryButton } from "@/components/AccountShell";
import { useAuth } from "@/components/AuthProvider";
import { accountApi } from "@/lib/account-api";
import { displayName } from "@/lib/customer-session";
import { formatPhone } from "@/lib/checkout-api";
import { formatIndianDate } from "@/lib/formatters";

export default function ProfilePage() {
  const { user, refreshProfile } = useAuth();
  const [firstName, setFirstName] = useState(user?.firstName ?? "");
  const [lastName, setLastName] = useState(user?.lastName ?? "");
  const [newsletter, setNewsletter] = useState(user?.newsletterSubscribed ?? false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!user) return null;
  const dirty =
    firstName.trim() !== (user.firstName ?? "") ||
    lastName.trim() !== (user.lastName ?? "") ||
    newsletter !== user.newsletterSubscribed;

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firstName.trim() || !lastName.trim()) {
      setError("Please enter your first and last name.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await accountApi.updateProfile({
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        newsletterSubscribed: newsletter,
      });
      await refreshProfile();
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save your profile.");
    } finally {
      setSaving(false);
    }
  };

  const initials = displayName(user).split(/\s+/).map((p) => p[0]).join("").slice(0, 2).toUpperCase();

  return (
    <AccountShell title="Your profile" subtitle="A little space for all things you." crumbs={[{ label: "Your profile" }]}>
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        <form onSubmit={handleSave} noValidate className="xl:col-span-8 bg-white rounded-3xl p-6 md:p-8 border border-[#E6EAE7] space-y-6 shadow-xs min-w-0">
          <div className="flex flex-wrap items-center gap-4 pb-6 border-b border-[#F0F2F1]">
            <div aria-hidden className="w-16 h-16 shrink-0 rounded-full bg-[#116644] text-white font-heading text-[20px] font-bold flex items-center justify-center">
              {initials}
            </div>
            <div className="min-w-0">
              <span className="font-heading text-[18px] font-bold text-[#113322] block truncate">{displayName(user)}</span>
              <span className="text-[13px] text-[#8A958E]">Member since {formatIndianDate(user.createdAt)}</span>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="space-y-1.5 block">
              <span className="text-[13px] font-medium text-[#4A5550]">First name</span>
              <input className={inputClass} value={firstName} maxLength={60} autoComplete="given-name" onChange={(e) => setFirstName(e.target.value)} />
            </label>
            <label className="space-y-1.5 block">
              <span className="text-[13px] font-medium text-[#4A5550]">Last name</span>
              <input className={inputClass} value={lastName} maxLength={60} autoComplete="family-name" onChange={(e) => setLastName(e.target.value)} />
            </label>
            <label className="space-y-1.5 block sm:col-span-2">
              <span className="text-[13px] font-medium text-[#4A5550]">Email</span>
              <input className={inputClass} value={user.email} disabled readOnly />
              <span className="text-[12px] text-[#8A958E] flex items-center gap-1">
                {user.emailVerified ? <><Check className="h-3.5 w-3.5 text-[#116644]" /> Verified</> : "Not verified yet"}
              </span>
            </label>
            {user.phone && (
              <label className="space-y-1.5 block sm:col-span-2">
                <span className="text-[13px] font-medium text-[#4A5550]">Phone</span>
                <input className={inputClass} value={formatPhone(user.phone)} disabled readOnly />
              </label>
            )}
          </div>

          <label className="flex items-start gap-3 cursor-pointer">
            <input type="checkbox" className="mt-1 h-4 w-4 accent-[#116644]" checked={newsletter} onChange={(e) => setNewsletter(e.target.checked)} />
            <span className="text-[14px] text-[#4A5550]">Send me product launches and sale alerts by email.</span>
          </label>

          {error && <p role="alert" className="text-[13px] text-red-600">{error}</p>}
          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" className={primaryButton} disabled={saving || !dirty}>
              {saving ? "Saving…" : "Save changes"}
            </button>
            {saved && (
              <span role="status" className="text-[13px] text-[#116644] flex items-center gap-1">
                <Check className="h-4 w-4" /> Saved
              </span>
            )}
          </div>
          <p className="text-[12px] text-[#8A958E]">To change your email or phone number, contact support.</p>
        </form>

        <div className="xl:col-span-4 space-y-6">
          <div className="bg-[#F2F5F3] rounded-3xl p-6 border border-[#E0EFE5] space-y-3">
            <div className="flex items-center gap-2">
              {user.mfaEnabled ? <ShieldCheck className="h-5 w-5 text-[#116644]" /> : <ShieldAlert className="h-5 w-5 text-amber-600" />}
              <h2 className="font-heading text-[16px] font-bold text-[#113322]">Two-factor authentication</h2>
            </div>
            <p className="text-[13px] text-[#4A5550]">
              {user.mfaEnabled
                ? "On. You’ll be asked for a code from your authenticator app when you sign in."
                : "Optional. Adds a code from an authenticator app when you sign in."}
            </p>
            <Link href="/account/security/2fa" className="block w-full rounded-xl bg-[#116644] py-2.5 text-center text-[13px] font-semibold text-white hover:bg-[#0e5237]">
              {user.mfaEnabled ? "Manage 2FA" : "Set up 2FA"} →
            </Link>
          </div>
          <div className="bg-white rounded-3xl p-6 border border-[#E6EAE7] space-y-2">
            <h2 className="font-heading text-[16px] font-bold text-[#113322]">Signed-in devices</h2>
            <p className="text-[13px] text-[#4A5550]">See where you’re signed in and sign out other devices.</p>
            <Link href="/account/sessions" className="text-[#116644] font-semibold text-[13px] hover:underline inline-block pt-1">
              Manage sessions →
            </Link>
          </div>
        </div>
      </div>
    </AccountShell>
  );
}
