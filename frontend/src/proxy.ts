import { NextResponse, type NextRequest } from 'next/server';
import converted from '@/data/legacy-redirects.json';
import extra from '@/data/legacy-redirects-extra.json';
import { buildLegacyMap, legacyRedirect, normalizeQuery } from '@/lib/legacy-redirects';

/**
 * Old OpenCart addresses (Phase 15): a 301 to their new page before routing; every other request goes on unchanged
 * (pages, and the normal prerendered 404 for unknown addresses). The hand-written entries win over the converter's.
 */
const LEGACY = buildLegacyMap(converted, extra);

export function proxy(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl;
  const to = legacyRedirect(pathname, normalizeQuery(searchParams.entries()), LEGACY);
  if (!to) return NextResponse.next();
  // same host as the request: Next sends a relative Location, so the host behind CloudFront/ALB never leaks in
  return NextResponse.redirect(new URL(to, request.url), 301);
}

export const config = {
  // not Next's files, the API proxy, media or probes (they can never be old store pages)
  matcher: ['/((?!_next/static|_next/image|api/|media/|health/|favicon.ico).*)'],
};
