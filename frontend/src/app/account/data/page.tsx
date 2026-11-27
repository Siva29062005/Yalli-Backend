"use client";

import React, { useState } from "react";
import Link from "next/link";
import { Download, Trash2 } from "lucide-react";
import { AccountShell, inputClass, primaryButton, secondaryButton } from "@/components/AccountShell";
import { useAuth } from "@/components/AuthProvider";
import { accountApi } from "@/lib/account-api";

const card = "rounded-3xl border border-[#E6EAE7] bg-white p-5 md:p-8 space-y-4 max-w-2xl";
const message = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

/** The customer's rights over their data (DPDP Act): a copy of it, and erasure. The server re-checks the password. */
export default function DataPage() {
  const { user, logout } = useAuth();
  const [form, setForm] = useState<"export" | "delete" | null>(null);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exported, setExported] = useState(false);

  if (!user) return null;
  const isStaff = user.roles.some((r) => r !== "CUSTOMER");
  const open = (which: "export" | "delete") => {
    setForm(which);
    setPassword("");
    setCode("");
    setConfirmText("");
    setError(null);
    setExported(false);
  };
  const credentials = (
    <>
      <label className="block space-y-1.5">
        <span className="text-[13px] font-medium text-[#4A5550]">Your password</span>
        <input type="password" autoComplete="current-password" className={`${inputClass} max-w-sm`} value={password} onChange={(e) => setPassword(e.target.value)} required />
      </label>
      {user.mfaEnabled && (
        <label className="block space-y-1.5">
          <span className="text-[13px] font-medium text-[#4A5550]">6-digit code from your authenticator app</span>
          <input
            className={`${inputClass} max-w-[220px] font-mono tracking-[0.3em]`}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            required
          />
        </label>
      )}
    </>
  );
  const ready = !!password && (!user.mfaEnabled || code.length === 6);

  const download = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const data = await accountApi.exportData(password, user.mfaEnabled ? code : undefined);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `yalli-my-data-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setExported(true);
      setPassword("");
      setCode("");
    } catch (err) {
      setError(message(err, "Could not prepare your data."));
    } finally {
      setBusy(false);
    }
  };

  const erase = async (e: React.FormEvent) => {
    e.preventDefault();
    if (confirmText !== "DELETE") return setError("Type DELETE to confirm.");
    setBusy(true);
    setError(null);
    try {
      await accountApi.deleteAccount(password, user.mfaEnabled ? code : undefined);
      await logout("/?account=deleted");
    } catch (err) {
      setError(message(err, "Could not delete your account."));
      setBusy(false);
    }
  };

  return (
    <AccountShell title="Your data" subtitle="Get a copy of what we store about you, or close your account.">
      <section className={card} aria-labelledby="export-h">
        <h2 id="export-h" className="font-heading text-[20px] font-bold text-[#113322] flex items-center gap-2">
          <Download className="h-5 w-5 text-[#116644]" aria-hidden /> Download my data
        </h2>
        <p className="text-[14px] text-[#4A5550]">
          A file with your profile, addresses, orders, reviews, wishlist and cart. See the{" "}
          <Link href="/privacy" className="font-semibold text-[#116644] hover:underline">privacy policy</Link> for what we keep and why.
        </p>
        {form === "export" ? (
          <form onSubmit={download} className="space-y-4 border-t border-[#F0F2F1] pt-4">
            {credentials}
            {error && <p role="alert" className="text-[13px] text-red-600">{error}</p>}
            <div className="flex gap-2">
              <button type="submit" className={primaryButton} disabled={busy || !ready}>{busy ? "Preparing…" : "Download"}</button>
              <button type="button" className={secondaryButton} onClick={() => setForm(null)}>Cancel</button>
            </div>
          </form>
        ) : (
          <button type="button" className={secondaryButton} onClick={() => open("export")}>Download my data</button>
        )}
        {exported && <p role="status" className="text-[13px] text-[#116644]">Your file has been downloaded.</p>}
      </section>

      <section className={card} aria-labelledby="delete-h">
        <h2 id="delete-h" className="font-heading text-[20px] font-bold text-[#113322] flex items-center gap-2">
          <Trash2 className="h-5 w-5 text-red-600" aria-hidden /> Delete my account
        </h2>
        {isStaff ? (
          <p className="text-[14px] text-[#4A5550]">Staff accounts are closed by an administrator.</p>
        ) : (
          <>
            <p className="text-[14px] text-[#4A5550]">
              Your profile, addresses, saved items, reviews and sign-in details are erased and you are signed out everywhere.
              Orders and invoices are kept without your name for as long as tax law requires. This cannot be undone.
            </p>
            {form === "delete" ? (
              <form onSubmit={erase} className="space-y-4 border-t border-[#F0F2F1] pt-4">
                {credentials}
                <label className="block space-y-1.5">
                  <span className="text-[13px] font-medium text-[#4A5550]">Type DELETE to confirm</span>
                  <input className={`${inputClass} max-w-[220px]`} autoComplete="off" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} required />
                </label>
                {error && <p role="alert" className="text-[13px] text-red-600">{error}</p>}
                <div className="flex gap-2">
                  <button type="submit" className={`${primaryButton} !bg-red-600 hover:!bg-red-700`} disabled={busy || !ready || confirmText !== "DELETE"}>
                    {busy ? "Deleting…" : "Delete my account"}
                  </button>
                  <button type="button" className={secondaryButton} onClick={() => setForm(null)}>Cancel</button>
                </div>
              </form>
            ) : (
              <button type="button" className={`${secondaryButton} text-red-700`} onClick={() => open("delete")}>Delete my account…</button>
            )}
          </>
        )}
      </section>
    </AccountShell>
  );
}
