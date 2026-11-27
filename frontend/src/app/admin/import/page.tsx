'use client';

import { useState } from 'react';
import { Upload } from 'lucide-react';
import { useAdminSession } from '@/components/AdminContext';
import { Alert, AdminPage, adminButton, adminCard, adminGhostButton } from '@/components/AdminKit';
import { adminRequest } from '@/lib/admin-session';
import { ApiError } from '@/lib/http';

interface ImportReport {
  mode: 'DRY_RUN' | 'APPLIED';
  categories: { created: number; existing: number };
  brands: { created: number; existing: number };
  products: { created: number; updated: number; skipped: number; failed: number };
  variants: { created: number; updated: number };
  failures: { product: string; reason: string }[];
}
interface Issue {
  path?: string;
  message: string;
}

const MAX_BYTES = 2 * 1024 * 1024;

/**
 * Catalogue import (products.create + pricing.update). Same rules as the import command: the whole file is checked
 * first, nothing is written by a check, new products arrive as DRAFTs, live stock and status are never overwritten.
 * "Import now" is offered only after a check of this exact file with these options (the server insists too).
 */
export default function AdminImportPage() {
  const { withStepUp, can } = useAdminSession();
  const [file, setFile] = useState<File | null>(null);
  const [updateExisting, setUpdateExisting] = useState(false);
  const [publish, setPublish] = useState(false);
  const [checked, setChecked] = useState<{ file: File; options: string; report: ImportReport } | null>(null);
  const [applied, setApplied] = useState<ImportReport | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const options = `${updateExisting}|${publish}`;
  const ready = checked !== null && checked.file === file && checked.options === options && checked.report.products.failed === 0;

  async function send(apply: boolean) {
    if (!file) return;
    setBusy(true);
    setError('');
    setIssues([]);
    if (!apply) setApplied(null);
    try {
      const report = await withStepUp(() => {
        const form = new FormData();
        form.set('file', file);
        form.set('apply', String(apply));
        form.set('updateExisting', String(updateExisting));
        form.set('publish', String(publish));
        return adminRequest<ImportReport>('/admin/catalog/import', { method: 'POST', body: form });
      });
      if (apply) {
        setApplied(report);
        setChecked(null);
      } else setChecked({ file, options, report });
    } catch (e) {
      setChecked(null);
      setError(e instanceof Error && e.message ? e.message : 'The import did not work. Please try again.');
      if (e instanceof ApiError && Array.isArray(e.details)) setIssues(e.details as Issue[]);
    } finally {
      setBusy(false);
    }
  }

  const report = applied ?? checked?.report ?? null;

  return (
    <AdminPage eyebrow="Catalogue" title="Import products" subtitle="Bring in many products at once from a catalogue file (JSON, up to 500 products and 2 MB). Larger files: use the import command.">
      {error && <Alert kind="error">{error}</Alert>}
      {issues.length > 0 && (
        <section className={`${adminCard} p-4`} aria-label="Problems in the file">
          <h2 className="mb-2 font-semibold">Problems in the file (nothing was imported)</h2>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {issues.map((i, n) => (
              <li key={n}>
                {i.path ? <code className="mr-1 rounded bg-[#F7F9F8] px-1">{i.path}</code> : null}
                {i.message}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className={`${adminCard} space-y-4 p-5`}>
        <label className={`${adminGhostButton} inline-flex cursor-pointer items-center gap-2`}>
          <Upload className="h-4 w-4" /> {file ? file.name : 'Choose a catalogue file'}
          <input
            type="file"
            accept="application/json,.json"
            className="sr-only"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              setError('');
              setIssues([]);
              setChecked(null);
              setApplied(null);
              if (f && f.size > MAX_BYTES) {
                setFile(null);
                setError('The file is larger than 2 MB. Split it, or use the import command.');
              } else setFile(f);
              e.target.value = '';
            }}
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={updateExisting} onChange={(e) => setUpdateExisting(e.target.checked)} />
          Update products that already exist (matched by their address). Live stock and status are never changed.
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={publish} disabled={!can('products.publish')} onChange={(e) => setPublish(e.target.checked)} />
          Publish the products the file marks as published (otherwise everything new arrives as a draft)
        </label>
        {!can('pricing.update') && <Alert kind="warning">Importing sets prices, so it also needs price access (pricing.update). Ask an administrator.</Alert>}
        {!can('inventory.adjust') && <p className="text-xs text-[#4A5550]">Files that set opening stock need stock access (inventory.adjust).</p>}
        <div className="flex flex-wrap gap-3">
          <button type="button" className={adminGhostButton} disabled={!file || busy} onClick={() => void send(false)}>
            {busy && !ready ? 'Checking…' : 'Check file'}
          </button>
          <button
            type="button"
            className={adminButton}
            disabled={!ready || busy}
            onClick={() => {
              if (window.confirm(`Import ${checked!.report.products.created + checked!.report.products.updated} product(s) now?`)) void send(true);
            }}
          >
            {busy && ready ? 'Importing…' : 'Import now'}
          </button>
        </div>
        <p className="text-xs text-[#4A5550]">“Check file” writes nothing. “Import now” is available after a check of this file with these options, for 30 minutes.</p>
      </section>

      {report && (
        <section className={`${adminCard} space-y-3 p-5`} aria-label="Import report">
          <h2 className="font-heading text-lg font-bold">{report.mode === 'APPLIED' ? 'Imported' : 'What the import would do'}</h2>
          {report.mode === 'APPLIED' && <Alert kind="success">Import finished. New products are drafts until you publish them.</Alert>}
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            {[
              ['New products', report.products.created],
              ['Updated products', report.products.updated],
              ['Left as they are', report.products.skipped],
              ['Failed', report.products.failed],
              ['New variants', report.variants.created],
              ['New categories', report.categories.created],
              ['New brands', report.brands.created],
            ].map(([label, n]) => (
              <div key={label} className="rounded-xl bg-[#F7F9F8] p-3">
                <dt className="text-xs text-[#4A5550]">{label}</dt>
                <dd className="text-xl font-bold">{n}</dd>
              </div>
            ))}
          </dl>
          {report.failures.length > 0 && (
            <ul className="list-disc space-y-1 pl-5 text-sm text-red-800">
              {report.failures.map((f, i) => <li key={i}>{f.product}: {f.reason}</li>)}
            </ul>
          )}
        </section>
      )}
    </AdminPage>
  );
}
