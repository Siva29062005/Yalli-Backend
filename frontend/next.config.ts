import type { NextConfig } from "next";

// `npm run test:browser` builds into its own folder with test settings (mock API, example site address), so it never
// replaces the normal `.next` build. Unset in every real build.
const browserTestDir = process.env.NEXT_DIST_DIR === '.next-browser-tests' ? '.next-browser-tests' : undefined;

// Content-Security-Policy without nonces (Next's documented header approach; nonces would force EVERY page to render on
// each request, losing the static and cached pages). Scripts only from this site, Razorpay Checkout and Cloudflare
// Turnstile; no plugins, no framing of this site, no <base> tricks. 'unsafe-inline' for scripts stays because Next
// inlines its own bootstrap scripts; a stricter nonce or hash policy is a later decision (docs/security).
const isDev = process.env.NODE_ENV === 'development';
const httpsSite = (process.env.NEXT_PUBLIC_BUSINESS_WEBSITE_URL ?? '').startsWith('https://');
if (httpsSite && !process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim())
  console.warn(
    'NEXT_PUBLIC_TURNSTILE_SITE_KEY is not set: sign-up and password reset will fail against a production backend ' +
      '(it requires a Turnstile token).',
  );
const RAZORPAY = 'https://*.razorpay.com';
// A browser-side API on another origin (NEXT_PUBLIC_API_URL, instead of the same-origin /api/v1 proxy) must be allowed
// to receive the calls.
const apiOrigin = (() => {
  try {
    return process.env.NEXT_PUBLIC_API_URL ? new URL(process.env.NEXT_PUBLIC_API_URL).origin : '';
  } catch {
    return '';
  }
})();
const TURNSTILE = 'https://challenges.cloudflare.com';
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''} ${RAZORPAY} ${TURNSTILE}`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  // Product images come from the media host (backend in development, the CDN in production) as absolute URLs.
  `img-src 'self' data: blob: https:${httpsSite ? '' : ' http://localhost:* http://127.0.0.1:*'}`,
  `connect-src 'self'${apiOrigin ? ` ${apiOrigin}` : ''} ${RAZORPAY} ${TURNSTILE}${isDev ? ' ws://localhost:* ws://127.0.0.1:*' : ''}`,
  `frame-src ${RAZORPAY} ${TURNSTILE}`,
  `form-action 'self' ${RAZORPAY}`,
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "worker-src 'self' blob:",
  ...(httpsSite ? ['upgrade-insecure-requests'] : []),
  // Browsers report every blocked load to the API (POST /api/v1/csp-reports: sanitised log line "CSP violation").
  'report-uri /api/v1/csp-reports',
].join('; ');

// CSP_REPORT_ONLY=1 at build time sends the same policy as Content-Security-Policy-Report-Only: nothing is blocked,
// every violation is reported. For the first staging builds only (docs/ops/deployment-aws.md); production enforces.
const cspReportOnly = process.env.CSP_REPORT_ONLY === '1';

const securityHeaders = [
  { key: cspReportOnly ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy', value: csp },
  // HTTPS only from the first visit on (the API sends the same header). No `preload`: that is a separate, hard to
  // undo decision for the owner.
  ...(httpsSite ? [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' }] : []),
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), browsing-topics=()' },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  // The production container (frontend/Dockerfile) runs the self-contained server in .next/standalone. Only for that
  // build: `next start`, used by the tests and local runs, does not work with standalone output.
  // The tracing root is this folder (the build runs here), so server.js sits at the top of .next/standalone both in the
  // Docker build (frontend/ is the whole context) and locally (where the repository root has its own lockfile).
  ...(process.env.NEXT_OUTPUT_STANDALONE === '1'
    ? { output: 'standalone' as const, outputFileTracingRoot: process.cwd() }
    : {}),
  ...(browserTestDir ? { distDir: browserTestDir, typescript: { tsconfigPath: 'tsconfig.browser-tests.json' } } : {}),
  // Links in backend emails use these short paths; query strings (tokens) are preserved.
  async redirects() {
    return ['login', 'register', 'verify-email', 'reset-password'].map((p) => ({
      source: `/${p}`,
      destination: `/auth/${p}`,
      permanent: false,
    }));
  },
  // Account, cart, checkout, sign-in, order and staff pages must never be indexed (keep in step with PRIVATE_PATHS in
  // src/lib/seo.ts, which also feeds robots.txt).
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      ...['admin', 'account', 'cart', 'checkout', 'auth', 'orders', 'compare'].map((p) => ({
        source: `/${p}/:path*`,
        headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }],
      })),
      // Reset and verification links carry a token in the URL: never send any part of the address to another site.
      { source: '/auth/:path*', headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }] },
    ];
  },
  async rewrites() {
    const apiUrl = (process.env.API_INTERNAL_URL || 'http://127.0.0.1:3000/api/v1').replace(/\/$/, '');
    return [{ source: '/api/v1/:path*', destination: `${apiUrl}/:path*` }];
  },
  images: {
    remotePatterns: [
      {
        protocol: "http",
        hostname: "localhost",
      },
      {
        protocol: "https",
        hostname: "images.unsplash.com",
      },
    ],
  },
};

export default nextConfig;
