import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Links in backend emails use these short paths; query strings (tokens) are preserved.
  async redirects() {
    return ['login', 'register', 'verify-email', 'reset-password'].map((p) => ({
      source: `/${p}`,
      destination: `/auth/${p}`,
      permanent: false,
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
