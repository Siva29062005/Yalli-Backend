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
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), browsing-topics=()' },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
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
