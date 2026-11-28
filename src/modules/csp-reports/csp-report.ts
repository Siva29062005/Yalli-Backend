import { z } from 'zod';

/**
 * Content-Security-Policy violation reports, sent by BROWSERS (not by our code) to `report-uri /api/v1/csp-reports`
 * as `application/csp-report`. The body format is defined by the browser and grows over time, so this schema reads only
 * the fields we use and ignores the rest (a deliberate exception to the strict-schema rule: nothing from the body is
 * stored or assigned to a model; a few sanitised fields are logged). Browsers may send null for fields they cannot
 * report. Only the classic `report-uri` format is accepted: the storefront's policy does not use `report-to`.
 */
const text = z.string().max(4096).nullish();
export const cspReportSchema = z.object({
  'csp-report': z.object({
    'document-uri': text,
    'blocked-uri': text,
    'effective-directive': text,
    'violated-directive': text,
    'source-file': text,
    disposition: text,
  }),
});
export type CspReportBody = z.infer<typeof cspReportSchema>;

export interface CspViolation {
  directive: string;
  blocked: string;
  page: string;
  source: string;
  disposition: string;
}

const KEYWORDS = new Set([
  'inline',
  'eval',
  'data',
  'blob',
  'self',
  'wasm-eval',
  'trusted-types-policy',
]);

/** Printable ASCII only, short: a report is attacker-controlled text that ends up in our logs. */
function clean(value: string, max = 120): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[^\x20-\x7e]/g, '?').slice(0, max);
}

/**
 * Only the origin and path of a URL: query strings and fragments can hold tokens (reset and verification links) and
 * must never reach a log. Keywords (`inline`, `eval`) are kept as they are; anything else becomes "other".
 */
export function safeUrl(value: string | null | undefined): string {
  if (!value) return '-';
  const v = value.trim();
  if (KEYWORDS.has(v)) return v;
  try {
    const u = new URL(v);
    if (u.protocol !== 'http:' && u.protocol !== 'https:')
      return clean(u.protocol, 20);
    return clean(`${u.origin}${u.pathname}`);
  } catch {
    return 'other';
  }
}

export function toViolation(body: CspReportBody): CspViolation {
  const r = body['csp-report'];
  return {
    directive: clean(
      r['effective-directive'] ?? r['violated-directive']?.split(' ')[0] ?? '-',
      40,
    ),
    blocked: safeUrl(r['blocked-uri']),
    page: safeUrl(r['document-uri']),
    source: safeUrl(r['source-file']),
    disposition: clean(r.disposition ?? '-', 20),
  };
}
