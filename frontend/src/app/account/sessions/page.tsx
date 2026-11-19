"use client";

import React, { useState } from "react";
import { Monitor, Smartphone } from "lucide-react";
import { AccountShell, PanelError, PanelLoading, secondaryButton } from "@/components/AccountShell";
import { accountApi, describeDevice, type DeviceSession } from "@/lib/account-api";
import { useAsync } from "@/lib/useAsync";

const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });

export default function SessionsPage() {
  const { data, setData, error, loading, reload } = useAsync(() => accountApi.sessions(), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const revoke = async (s: DeviceSession) => {
    setBusy(s.id);
    setActionError(null);
    try {
      await accountApi.revokeSession(s.id);
      setData((list) => (list ?? []).filter((x) => x.id !== s.id));
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Could not sign out that device.");
    } finally {
      setBusy(null);
    }
  };

  const others = (data ?? []).filter((s) => !s.current);
  const revokeAll = async () => {
    if (!window.confirm(`Sign out ${others.length} other device${others.length === 1 ? "" : "s"}?`)) return;
    for (const s of others) await revoke(s);
  };

  const list = [...(data ?? [])].sort((a, b) => Number(b.current) - Number(a.current));

  return (
    <AccountShell
      title="Signed-in devices"
      subtitle="If you don’t recognise a device, sign it out and change your password."
      crumbs={[{ label: "Sessions" }]}
      actions={
        others.length > 0 ? (
          <button type="button" className={secondaryButton} onClick={revokeAll} disabled={!!busy}>
            Sign out all other devices
          </button>
        ) : undefined
      }
    >
      {actionError && <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-[13px] text-red-700">{actionError}</p>}
      {loading && !data ? (
        <PanelLoading label="Loading your sessions…" />
      ) : error ? (
        <PanelError message={error} onRetry={reload} />
      ) : (
        <ul className="space-y-3">
          {list.map((s) => {
            const mobile = /iPhone|Android|Mobile/.test(s.userAgent ?? "");
            const Icon = mobile ? Smartphone : Monitor;
            return (
              <li key={s.id} className="flex flex-col sm:flex-row sm:items-center gap-4 rounded-3xl border border-[#E6EAE7] bg-white p-5 min-w-0">
                <Icon className="h-6 w-6 shrink-0 text-[#116644]" aria-hidden />
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[14px] font-semibold text-[#113322] break-words">{describeDevice(s.userAgent)}</span>
                    {s.current && <span className="rounded-full bg-[#E0EFE5] px-2.5 py-0.5 text-[11px] font-semibold text-[#116644]">This device</span>}
                  </div>
                  <p className="text-[12px] text-[#8A958E] break-words">
                    {s.deviceLabel ? `${s.deviceLabel} · ` : ""}
                    {s.ip ?? "Unknown location"} · last active {when(s.lastSeenAt)}
                  </p>
                  <p className="text-[12px] text-[#8A958E]">Signed in {when(s.createdAt)}</p>
                </div>
                {!s.current && (
                  <button type="button" className={secondaryButton} disabled={busy === s.id} onClick={() => revoke(s)}>
                    {busy === s.id ? "Signing out…" : "Sign out"}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </AccountShell>
  );
}
