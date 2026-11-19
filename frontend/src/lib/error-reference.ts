/** The opaque reference Next.js attaches to a server error (`digest`), safe to show: it matches a server log line and reveals nothing. */
export function errorReference(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('digest' in error)) return null;
  const { digest } = error as { digest?: unknown };
  return typeof digest === 'string' && /^[\w-]{1,40}$/.test(digest) ? digest : null;
}
