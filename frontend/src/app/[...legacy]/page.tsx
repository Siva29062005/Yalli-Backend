import { notFound, permanentRedirect } from 'next/navigation';
import data from '@/data/legacy-redirects.json';
import { buildLegacyMap, resolveLegacy } from '@/lib/legacy-redirects';

/**
 * Catches only addresses no other page matches: old OpenCart links (`/index.php?route=…`, SEO keywords) get a permanent
 * redirect (308) to their new page; everything else is the normal 404. No loading.tsx may sit above this page (a
 * streamed answer would fix the status at 200).
 */
const LEGACY = buildLegacyMap(data);

export default async function LegacyAddress({
  params,
  searchParams,
}: {
  params: Promise<{ legacy: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ legacy }, sp] = await Promise.all([params, searchParams]);
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (typeof v === 'string') query.set(k, v);
  const segments = legacy.map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  const to = resolveLegacy(segments, query, LEGACY);
  if (to) permanentRedirect(to);
  notFound();
}
