import type { NextConfig } from "next";

// `npm run test:browser` builds into its own folder with test settings (mock API, example site address), so it never
// replaces the normal `.next` build. Unset in every real build.
const browserTestDir = process.env.NEXT_DIST_DIR === '.next-browser-tests' ? '.next-browser-tests' : undefined;

const nextConfig: NextConfig = {
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
    return ['admin', 'account', 'cart', 'checkout', 'auth', 'orders', 'compare'].map((p) => ({
      source: `/${p}/:path*`,
      headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }],
    }));
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
