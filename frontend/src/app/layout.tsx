import type { Metadata } from 'next';
import './globals.css';
import { CategoryProvider } from '@/components/CategoryProvider';
import { AuthProvider } from '@/components/AuthProvider';
import { CartProvider } from '@/components/CartProvider';
import { WishlistProvider } from '@/components/WishlistProvider';

export const metadata: Metadata = {
  title: 'Yalli · Everything for a happier home',
  description:
    'Quality home, electronics, kitchen & lifestyle products, delivered across India. Thoughtfully chosen. Honestly priced.',
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
