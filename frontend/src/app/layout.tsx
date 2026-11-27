import type { Metadata } from 'next';
import './globals.css';
import { CategoryProvider } from '@/components/CategoryProvider';
import { AuthProvider } from '@/components/AuthProvider';
import { CartProvider } from '@/components/CartProvider';
import { WishlistProvider } from '@/components/WishlistProvider';
import { BUSINESS } from '@/lib/business';
import { SITE_URL } from '@/lib/site';

const description =
  'Quality home, electronics, kitchen & lifestyle products, delivered across India. Thoughtfully chosen. Honestly priced.';

export const metadata: Metadata = {
  // Relative canonical and image URLs resolve against this; it is only set when the real address is configured.
  ...(SITE_URL ? { metadataBase: new URL(SITE_URL) } : {}),
  title: 'Yalli · Everything for a happier home',
  description,
  applicationName: BUSINESS.tradeName,
  openGraph: { type: 'website', siteName: BUSINESS.tradeName, locale: 'en_IN', title: 'Yalli · Everything for a happier home', description },
  twitter: { card: 'summary_large_image' },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        {/* Root App Router layout, so the font loads on every page; the rule targets the pages router. Google Fonts is
            named in the privacy policy; switching to self-hosted fonts (next/font) must update that page too. */}
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Poppins:wght@500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-screen flex flex-col bg-[#FAFAFA] text-[#113322] antialiased">
        <AuthProvider>
          <CartProvider>
          <WishlistProvider>
            <CategoryProvider>{children}</CategoryProvider>
          </WishlistProvider>
          </CartProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
