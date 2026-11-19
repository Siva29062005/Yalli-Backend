This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Run the backend on port 3000 and the frontend with `npm run dev -- --port 3001`, then open http://localhost:3001/admin.

Browser API requests use `/api/v1` on the frontend origin. Next.js proxies them to `http://127.0.0.1:3000/api/v1` by default. This avoids sending API requests to a different service when `localhost` resolves to IPv6 but a development SSH tunnel listens only on IPv4.

Set `API_INTERNAL_URL` in the frontend environment to change the backend target (include `/api/v1`). Restart Next.js after changing it; rebuild production deployments after changing rewrite configuration. Keep the backend on a different listener from the frontend to avoid a proxy loop. Server-rendered requests use this absolute backend URL too.

`NEXT_PUBLIC_API_URL` overrides the API URL for direct browser access only when explicitly configured. Such deployments need the backend's CORS allow-list and cookie settings configured for the frontend origin; never include credentials in either URL.

Admin sign-in still requires an existing staff account and MFA. Seeding does not reset an existing Super Admin or create the example credentials when another Super Admin already exists.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
