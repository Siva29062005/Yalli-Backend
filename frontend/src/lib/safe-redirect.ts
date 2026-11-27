const BASE = 'https://same-site.invalid';

/**
 * Post-login redirect target: only a path on THIS site, never another origin (open-redirect defence).
 * Browsers strip tabs and newlines from URLs and treat "\" like "/", so "/\t/evil.com" or "/\evil.com" would become
 * "//evil.com" (another site). We reject those characters outright, then let the URL parser resolve the path and check
 * that it stays on our origin and does not normalise to a protocol-relative "//host" (e.g. "/.//evil.com").
 * Sign-in and staff pages are never targets.
 */
export function safeNext(next: string | null | undefined, fallback = '/account/profile'): string {
  if (!next || next.length > 2048) return fallback;
  // Control characters (tab, newline …) and backslashes are exactly what browsers silently rewrite.
  if (/[\u0000-\u001f\u007f\\]/.test(next)) return fallback;
  if (!next.startsWith('/') || next.startsWith('//')) return fallback;
  let url: URL;
  try {
    url = new URL(next, BASE);
  } catch {
    return fallback;
  }
  if (url.origin !== BASE) return fallback;
  const path = `${url.pathname}${url.search}${url.hash}`;
  if (path.startsWith('//')) return fallback;
  if (url.pathname === '/auth' || url.pathname.startsWith('/auth/') || url.pathname === '/admin' || url.pathname.startsWith('/admin/'))
    return fallback;
  return path;
}
