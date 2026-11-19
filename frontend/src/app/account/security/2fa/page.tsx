"use client";

import React, { useState } from "react";
import { Copy, Download, ShieldCheck, ShieldOff } from "lucide-react";
import { AccountShell, inputClass, primaryButton, secondaryButton } from "@/components/AccountShell";
import { useAuth } from "@/components/AuthProvider";
import { accountApi } from "@/lib/account-api";

type Step = { kind: "idle" } | { kind: "scan"; secret: string; uri: string } | { kind: "codes"; codes: string[] };

const err = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

/** Customer 2FA is optional: enable, disable, and regenerate recovery codes. All checks are done by the server. */
export default function TwoFactorPage() {
  const { user, refreshProfile } = useAuth();
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"disable" | "regen" | null>(null);

  if (!user) return null;

  const wrap = async (fn: () => Promise<void>, fallback: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(err(e, fallback));
    } finally {
      setBusy(false);
    }
  };

  const start = (e: React.FormEvent) => {
    e.preventDefault();
    void wrap(async () => {
      const r = await accountApi.mfaEnroll(password);
      setPassword("");
      setStep({ kind: "scan", secret: r.secret, uri: r.otpauthUri });
    }, "Could not start setup.");
  };

  const confirm = (e: React.FormEvent) => {
    e.preventDefault();
    void wrap(async () => {
      const r = await accountApi.mfaConfirm(code);
      setCode("");
      setStep({ kind: "codes", codes: r.recoveryCodes });
      await refreshProfile();
    }, "That code didn’t work.");
  };

  const disable = (e: React.FormEvent) => {
    e.preventDefault();
    void wrap(async () => {
      await accountApi.mfaDisable({ password, code });
      setPassword("");
      setCode("");
      setMode(null);
      await refreshProfile();
    }, "Could not turn off 2FA.");
  };

  const regenerate = (e: React.FormEvent) => {
    e.preventDefault();
    void wrap(async () => {
      const r = await accountApi.mfaRegenerate(code);
      setCode("");
      setMode(null);
      setStep({ kind: "codes", codes: r.recoveryCodes });
    }, "Could not create new codes.");
  };

  const codeInput = (
    <label className="block space-y-1.5">
      <span className="text-[13px] font-medium text-[#4A5550]">6-digit code from your app</span>
      <input
        className={`${inputClass} tracking-[0.3em] font-mono max-w-[220px]`}
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
        required
      />
    </label>
  );
  const passwordInput = (
    <label className="block space-y-1.5">
      <span className="text-[13px] font-medium text-[#4A5550]">Your password</span>
      <input type="password" className={`${inputClass} max-w-sm`} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
    </label>
  );
  const errorBox = error && <p role="alert" className="text-[13px] text-red-600">{error}</p>;
  const card = "rounded-3xl border border-[#E6EAE7] bg-white p-5 md:p-8 space-y-5 max-w-2xl";

  return (
    <AccountShell
      title="Two-factor authentication"
      subtitle="Optional extra protection: a code from an authenticator app at sign-in."
      crumbs={[{ label: "Profile", href: "/account/profile" }, { label: "Two-factor authentication" }]}
    >
      {step.kind === "codes" ? (
        <section className={card}>
          <h2 className="font-heading text-[20px] font-bold text-[#113322] flex items-center gap-2"><ShieldCheck className="h-5 w-5 text-[#116644]" /> Save your recovery codes</h2>
          <p className="text-[14px] text-[#4A5550]">Each code works once if you lose your phone. They won’t be shown again.</p>
          <ul className="grid grid-cols-2 gap-2 rounded-2xl bg-[#F2F5F3] p-4 font-mono text-[14px] text-[#113322]">
            {step.codes.map((c) => <li key={c}>{c}</li>)}
          </ul>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={secondaryButton} onClick={() => navigator.clipboard?.writeText(step.codes.join("\n"))}><Copy className="h-4 w-4" /> Copy</button>
            <a
              className={secondaryButton}
              download="yalli-recovery-codes.txt"
              href={`data:text/plain;charset=utf-8,${encodeURIComponent(`Yalli recovery codes for ${user.email}\n\n${step.codes.join("\n")}\n`)}`}
            >
              <Download className="h-4 w-4" /> Download
            </a>
            <button type="button" className={primaryButton} onClick={() => setStep({ kind: "idle" })}>I’ve saved them</button>
          </div>
        </section>
      ) : step.kind === "scan" ? (
        <form onSubmit={confirm} className={card}>
          <h2 className="font-heading text-[20px] font-bold text-[#113322]">Add Yalli to your authenticator app</h2>
          <ol className="list-decimal pl-5 space-y-2 text-[14px] text-[#4A5550]">
            <li>Open Google Authenticator, Microsoft Authenticator, Authy or 1Password.</li>
            <li>Choose <strong>Enter a setup key</strong> and paste the key below (time-based). On this phone, you can also tap the link.</li>
          </ol>
          <div className="rounded-2xl bg-[#F2F5F3] p-4 space-y-2 min-w-0">
            <code className="block break-all font-mono text-[15px] text-[#113322]">{step.secret.replace(/(.{4})/g, "$1 ").trim()}</code>
            <div className="flex flex-wrap gap-2">
              <button type="button" className={secondaryButton} onClick={() => navigator.clipboard?.writeText(step.secret)}><Copy className="h-4 w-4" /> Copy key</button>
              <a className={secondaryButton} href={step.uri}>Open in authenticator app</a>
            </div>
          </div>
          {codeInput}
          {errorBox}
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={primaryButton} disabled={busy || code.length !== 6}>{busy ? "Checking…" : "Turn on 2FA"}</button>
            <button type="button" className={secondaryButton} onClick={() => { setStep({ kind: "idle" }); setError(null); }}>Cancel</button>
          </div>
        </form>
      ) : user.mfaEnabled ? (
        <section className={card}>
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-6 w-6 text-[#116644]" />
            <h2 className="font-heading text-[20px] font-bold text-[#113322]">2FA is on</h2>
          </div>
          <p className="text-[14px] text-[#4A5550]">You’ll be asked for a code from your authenticator app whenever you sign in.</p>
          {mode === null && (
            <div className="flex flex-wrap gap-2">
              <button type="button" className={secondaryButton} onClick={() => { setMode("regen"); setError(null); }}>New recovery codes</button>
              <button type="button" className={`${secondaryButton} text-red-700`} onClick={() => { setMode("disable"); setError(null); }}><ShieldOff className="h-4 w-4" /> Turn off 2FA</button>
            </div>
          )}
          {mode === "regen" && (
            <form onSubmit={regenerate} className="space-y-4 border-t border-[#F0F2F1] pt-5">
              <p className="text-[13px] text-[#4A5550]">Your old recovery codes will stop working.</p>
              {codeInput}
              {errorBox}
              <div className="flex gap-2">
                <button type="submit" className={primaryButton} disabled={busy || code.length !== 6}>{busy ? "Working…" : "Create new codes"}</button>
                <button type="button" className={secondaryButton} onClick={() => setMode(null)}>Cancel</button>
              </div>
            </form>
          )}
          {mode === "disable" && (
            <form onSubmit={disable} className="space-y-4 border-t border-[#F0F2F1] pt-5">
              {passwordInput}
              {codeInput}
              {errorBox}
              <div className="flex gap-2">
                <button type="submit" className={`${primaryButton} !bg-red-600 hover:!bg-red-700`} disabled={busy || !password || code.length !== 6}>{busy ? "Working…" : "Turn off 2FA"}</button>
                <button type="button" className={secondaryButton} onClick={() => setMode(null)}>Cancel</button>
              </div>
            </form>
          )}
        </section>
      ) : (
        <form onSubmit={start} className={card}>
          <h2 className="font-heading text-[20px] font-bold text-[#113322]">Turn on 2FA</h2>
          <p className="text-[14px] text-[#4A5550]">Confirm your password to begin. You’ll need an authenticator app on your phone.</p>
          {passwordInput}
          {errorBox}
          <button type="submit" className={primaryButton} disabled={busy || !password}>{busy ? "Starting…" : "Continue"}</button>
        </form>
      )}
    </AccountShell>
  );
}
