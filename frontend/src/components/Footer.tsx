'use client';
import { ALL_CATEGORY } from '@/lib/category-utils';

import Link from 'next/link';
import { BUSINESS, sellerName } from '@/lib/business';
import { BRAND } from '@/lib/constants';
import { useCategories } from '@/components/CategoryProvider';

const HELP_LINKS = [
  { href: '/help', label: 'Help & FAQs' },
  { href: '/shipping', label: 'Shipping & delivery' },
  { href: '/returns', label: 'Returns & refunds' },
  { href: '/privacy', label: 'Privacy policy' },
  { href: '/terms', label: 'Terms of use & sale' },
  { href: '/contact', label: 'Contact us' },
] as const;

export function Footer() {
  const { categories: CATEGORIES } = useCategories();

  return (
    <footer className="bg-[#113322] text-white mt-auto">
      {/* Category Links Strip */}
      <div className="border-b border-white/10 py-8 px-4 md:px-8 lg:px-12">
        <div className="max-w-[1600px] mx-auto flex flex-wrap items-center justify-between gap-4">
          <span className="text-[13px] text-white/50 font-medium uppercase tracking-wider">
            Explore Categories
          </span>
          <div className="min-w-0 max-w-full flex flex-wrap gap-x-6 gap-y-2 [&>a]:max-w-full [&>a]:[overflow-wrap:anywhere]">
            {CATEGORIES.map((cat) => (
              <Link
                key={cat.id}
                href={cat.id === ALL_CATEGORY.id ? '/catalog' : `/catalog/${cat.slug}`}
                className="text-[13px] text-white/80 hover:text-white transition"
              >
                {cat.name}
              </Link>
            ))}
            <Link href="/specials" className="text-[13px] text-white/80 hover:text-white transition">On sale</Link>
            <Link href="/brands" className="text-[13px] text-white/80 hover:text-white transition">Brands</Link>
          </div>
        </div>
      </div>

      {/* Main Footer Row */}
      <div className="max-w-[1600px] mx-auto px-4 md:px-8 lg:px-12 py-10 md:py-12">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          {/* Left: Brand & Copyright */}
          <div className="lg:col-span-4 space-y-2">
            <span className="font-heading text-[32px] font-bold text-white tracking-tight">
              {BRAND.name}
            </span>
            <p className="text-[13px] text-white/70">
              Made for the joy of home. © {new Date().getFullYear()} {sellerName()}
            </p>
            {BUSINESS.gstin && <p className="text-[12px] text-white/60">GSTIN: {BUSINESS.gstin}</p>}
          </div>

          {/* Center: Help & policies */}
          <nav aria-label="Help and policies" className="lg:col-span-4">
            <ul className="grid grid-cols-2 gap-x-6 gap-y-2 text-[14px] text-white/80">
              {HELP_LINKS.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    className="hover:text-white transition focus-visible:rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          {/* Right: email offers are a per-account choice, not a separate sign-up */}
          <div className="lg:col-span-4 space-y-2">
            <span className="text-[13px] text-white/90 font-medium block">Offers and new arrivals</span>
            <p className="text-[13px] text-white/70">
              Want them by email? Sign in and tick the box in{' '}
              <Link href="/account/profile" className="text-[#FF9900] underline underline-offset-2 hover:text-white">
                My profile
              </Link>
              . You can switch it off any time.
            </p>
          </div>
        </div>
      </div>
    </footer>
  );
}
