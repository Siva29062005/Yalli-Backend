"use client";

import React, { useState } from "react";
import Link from "next/link";
import { KeyRound, LogOut, ShieldCheck } from "lucide-react";
import { AccountShell, inputClass, primaryButton, secondaryButton } from "@/components/AccountShell";
import { useAuth } from "@/components/AuthProvider";
import { accountApi } from "@/lib/account-api";
import { fieldErrors, passwordProblems } from "@/lib/auth-api";
import { ApiError } from "@/lib/http";

const card = "rounded-3xl border border-[#E6EAE7] bg-white p-5 md:p-8 space-y-4 max-w-2xl";
const message = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

/** Sign-in and security: change password, two-step verification, sign out everywhere. The server checks everything. */
export default function SecurityPage() {
  const { user, endLocally } = useAuth();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState<"password" | "everywhere" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (!user) return null;
  const problems = next ? passwordProblems(next, { email: user.email, firstName: user.firstName ?? undefined, lastName: user.lastName ?? undefined }) : [];

  const changePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setDone(false);
    if (problems.length) return setError(problems[0]!);
    if (next !== confirm) return setError("The new passwords do not match.");
    setBusy("password");
    try {
      await accountApi.changePassword(current, next);
      setCurrent("");
      setNext("");
      setConfirm("");
      setDone(true);
    } catch (err) {
      // The server answers a wrong current password with 401, and password-policy problems as field messages
      // ("is too repetitive") that need their subject.
      const fields = fieldErrors(err);
      if (err instanceof ApiError && err.status === 401) setError("Your current password is not right.");
      else if (fields.newPassword) setError(/^[a-z]/.test(fields.newPassword) ? `The new password ${fields.newPassword}.` : fields.newPassword);
      else setError(fields.currentPassword ?? message(err, "Could not change your password."));
    } finally {
      setBusy(null);
    }
  };

  const signOutEverywhere = async () => {
    if (!window.confirm("Sign out of every device, including this one? You will need to sign in again.")) return;
    setBusy("everywhere");
    setError(null);
    try {
      await accountApi.logoutAll();
    } catch {
      /* signed out locally below either way */
    }
    endLocally("/auth/login");
  };

  return (
    <AccountShell title="Sign-in & security" subtitle="Your password, two-step verification and the devices you are signed in on.">
      <form onSubmit={changePassword} className={card} aria-labelledby="pw-h">
        <h2 id="pw-h" className="font-heading text-[20px] font-bold text-[#113322] flex items-center gap-2">
          <KeyRound className="h-5 w-5 text-[#116644]" aria-hidden /> Change password
        </h2>
        <p className="text-[14px] text-[#4A5550]">Your other devices are signed out when the password changes.</p>
        <label className="block space-y-1.5">
          <span className="text-[13px] font-medium text-[#4A5550]">Current password</span>
          <input type="password" autoComplete="current-password" className={`${inputClass} max-w-sm`} value={current} onChange={(e) => setCurrent(e.target.value)} required />
        </label>
        <label className="block space-y-1.5">
          <span className="text-[13px] font-medium text-[#4A5550]">New password</span>
          <input type="password" autoComplete="new-password" className={`${inputClass} max-w-sm`} value={next} onChange={(e) => setNext(e.target.value)} required aria-describedby="pw-rules" />
          <span id="pw-rules" className="block text-[12px] text-[#5F6B64]">At least 12 characters. A few random words work well.</span>
        </label>
        <label className="block space-y-1.5">
          <span className="text-[13px] font-medium text-[#4A5550]">Repeat the new password</span>
          <input type="password" autoComplete="new-password" className={`${inputClass} max-w-sm`} value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </label>
        {error && <p role="alert" className="text-[13px] text-red-600">{error}</p>}
        {done && <p role="status" className="text-[13px] text-[#116644]">Password changed. Other devices were signed out.</p>}
        <button type="submit" className={primaryButton} disabled={busy !== null || !current || !next || !confirm}>
          {busy === "password" ? "Changing…" : "Change password"}
        </button>
      </form>

      <section className={card} aria-labelledby="mfa-h">
        <h2 id="mfa-h" className="font-heading text-[20px] font-bold text-[#113322] flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-[#116644]" aria-hidden /> Two-step verification
        </h2>
        <p className="text-[14px] text-[#4A5550]">
          {user.mfaEnabled ? "On: a code from your authenticator app is asked for at sign-in." : "Off. Add a code from an authenticator app to your sign-in."}
        </p>
        <Link href="/account/security/2fa" className={secondaryButton}>
          {user.mfaEnabled ? "Manage two-step verification" : "Turn on two-step verification"}
        </Link>
      </section>

      <section className={card} aria-labelledby="out-h">
        <h2 id="out-h" className="font-heading text-[20px] font-bold text-[#113322] flex items-center gap-2">
          <LogOut className="h-5 w-5 text-[#116644]" aria-hidden /> Sign out everywhere
        </h2>
        <p className="text-[14px] text-[#4A5550]">
          Ends every session on every device, this one included. To sign out single devices, see{" "}
          <Link href="/account/sessions" className="font-semibold text-[#116644] hover:underline">signed-in devices</Link>.
        </p>
        <button type="button" className={`${secondaryButton} text-red-700`} onClick={signOutEverywhere} disabled={busy !== null}>
          {busy === "everywhere" ? "Signing out…" : "Sign out of all devices"}
        </button>
      </section>
    </AccountShell>
  );
}
