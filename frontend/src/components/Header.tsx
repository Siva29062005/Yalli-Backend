'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Search,
  Heart,
  User as UserIcon,
  ShoppingBag,
  Menu,
  X,
} from 'lucide-react';
import { BRAND } from '@/lib/constants';
import { useCategories } from '@/components/CategoryProvider';
import { useWishlist } from "@/components/WishlistProvider";
import { useStore } from '@/lib/store';
import { useCart } from '@/components/CartProvider';
import { useMounted } from '@/lib/useMounted';
import { useAuth } from '@/components/AuthProvider';
import { displayName } from '@/lib/customer-session';

export function Header() {
  const { categories: CATEGORIES } = useCategories();
  const mounted = useMounted();
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState('');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const { cart } = useCart();
  const cartCount = cart.itemCount;
  const wishlistCount = useWishlist().slugs.size;
  const { user } = useAuth();
  const setCartDrawerOpen = useStore((state) => state.setCartDrawerOpen);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      router.push(`/catalog?q=${encodeURIComponent(searchQuery.trim())}`);
    }
  };

  return (
    <header className="sticky top-0 z-40 bg-white border-b border-[#E6EAE7] transition-all">
      <div className="max-w-[1600px] mx-auto px-4 md:px-8 lg:px-12 h-[76px] flex items-center justify-between gap-4">
        {/* Brand Logo & Tagline */}
        <div className="flex items-center gap-3 shrink-0">
          <Link href="/" className="flex items-baseline gap-2 group">
            <span className="font-heading text-[32px] md:text-[34px] font-bold text-[#116644] tracking-tight group-hover:opacity-95 transition">
              {BRAND.name}
            </span>
            <span className="hidden sm:inline text-[13px] text-[#8A958E] font-medium tracking-normal">
              {BRAND.tagline}
            </span>
          </Link>
        </div>

        {/* Right Zone: Search & Actions */}
        <div className="flex items-center gap-3 sm:gap-4">
          {/* Search Bar matching Figma rounded style */}
          <form
            onSubmit={handleSearch}
            className="relative hidden md:block w-[240px] lg:w-[280px]"
          >
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[#8A958E]" />
            <input
              type="text"
              placeholder="Search your next favourite"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-[#F5F6F5] text-[13px] text-[#113322] placeholder-[#8A958E] pl-10 pr-4 py-2 rounded-full border border-transparent focus:border-[#116644] focus:bg-white outline-none transition"
            />
          </form>

          {/* Wishlist Link */}
          <Link
            href="/account/wishlist"
            className="relative p-2 text-[#113322] hover:text-[#116644] transition"
            title="Wishlist"
          >
            <Heart className="w-5 h-5 stroke-[1.75]" />
            {mounted && wishlistCount > 0 && (
              <span className="absolute top-1 right-1 w-4 h-4 bg-[#FF9900] text-white text-[10px] font-bold rounded-full flex items-center justify-center">
                {wishlistCount}
              </span>
            )}
          </Link>

          {/* User Account / Login */}
          <Link
            href={mounted && user ? '/account/profile' : '/auth/login'}
            className="p-2 text-[#113322] hover:text-[#116644] transition"
            title={mounted && user ? `Signed in as ${displayName(user)}` : 'Sign In'}
            aria-label={mounted && user ? 'Your account' : 'Sign in'}
          >
            <UserIcon className="w-5 h-5 stroke-[1.75]" />
          </Link>

          {/* Cart Icon with Orange Badge matching Figma */}
          <button
            onClick={() => setCartDrawerOpen(true)}
            className="relative p-2 text-[#113322] hover:text-[#116644] transition flex items-center"
            title="Shopping Cart"
            aria-label={mounted && cartCount > 0 ? `Cart, ${cartCount} items` : 'Cart'}
            type="button"
          >
            <ShoppingBag className="w-5 h-5 stroke-[1.75]" />
            {mounted && cartCount > 0 && (
              <span className="absolute top-0.5 right-0.5 w-4 h-4 bg-[#FF9900] text-white text-[10px] font-bold rounded-full flex items-center justify-center">
                {cartCount}
              </span>
            )}
          </button>

          {/* Mobile Menu Button */}
          <button
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            className="xl:hidden p-2 text-[#113322]"
            type="button"
            aria-label={mobileMenuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={mobileMenuOpen}
          >
            {mobileMenuOpen ? (
              <X className="w-6 h-6" />
            ) : (
              <Menu className="w-6 h-6" />
            )}
          </button>
        </div>
      </div>

      {/* Keep category navigation separate so it cannot crowd search and actions. */}
      <nav
        aria-label="Product categories"
        className="hidden xl:flex max-w-[1600px] mx-auto px-12 pb-4 items-center gap-x-6 [&>a]:min-w-0 [&>a]:max-w-48 [&>a]:truncate"
      >
        <Link
          href="/catalog"
          className="text-[14px] font-medium text-[#113322] hover:text-[#116644] transition whitespace-nowrap"
        >
          Shop all
        </Link>
        {CATEGORIES.filter((c) => c.id !== 'all')
          .slice(0, 4)
          .map((cat) => (
            <Link
              key={cat.id}
              href={`/catalog/${cat.slug}`}
              className="text-[14px] font-medium text-[#113322] hover:text-[#116644] transition whitespace-nowrap"
            >
              {cat.name}
            </Link>
          ))}
        {CATEGORIES.length > 5 && (
          <details className="relative ml-auto shrink-0">
            <summary className="cursor-pointer rounded-lg px-3 py-2 text-sm font-semibold text-[#116644]">
              All categories
            </summary>
            <div className="absolute right-0 top-full mt-2 grid w-[min(640px,85vw)] max-h-[60vh] grid-cols-2 gap-2 overflow-y-auto rounded-2xl border border-[#E6EAE7] bg-white p-4 shadow-xl">
              {CATEGORIES.filter((c) => c.id !== 'all').map((cat) => (
                <Link
                  key={cat.id}
                  href={`/catalog/${cat.slug}`}
                  onClick={(event) => {
                    event.currentTarget
                      .closest('details')
                      ?.removeAttribute('open');
                  }}
                  className="min-w-0 [overflow-wrap:anywhere] rounded-lg p-3 text-sm hover:bg-[#EEFFEE]"
                >
                  {cat.name}
                </Link>
              ))}
            </div>
          </details>
        )}
        <Link
          href="/compare"
          className="text-[14px] font-medium text-[#8A958E] hover:text-[#116644] transition whitespace-nowrap"
        >
          Compare
        </Link>
      </nav>

      {/* Mobile Menu Dropdown */}
      {mobileMenuOpen && (
        <div className="xl:hidden max-h-[calc(100dvh-76px)] overflow-y-auto bg-white border-t border-[#E6EAE7] px-6 py-4 space-y-3">
          <form onSubmit={handleSearch} className="relative mb-3">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[#8A958E]" />
            <input
              type="text"
              placeholder="Search your next favourite"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-[#F5F6F5] text-[14px] text-[#113322] placeholder-[#8A958E] pl-10 pr-4 py-2.5 rounded-full outline-none"
            />
          </form>
          <div className="grid grid-cols-2 gap-2 pt-2">
            <Link
              href="/catalog"
              onClick={() => setMobileMenuOpen(false)}
              className="text-[14px] font-medium text-[#113322] py-1.5"
            >
              Shop all
            </Link>
            {CATEGORIES.filter((c) => c.id !== 'all').map((cat) => (
              <Link
                key={cat.id}
                href={`/catalog/${cat.slug}`}
                onClick={() => setMobileMenuOpen(false)}
                className="min-w-0 [overflow-wrap:anywhere] text-[14px] font-medium text-[#113322] hover:text-[#116644] py-1.5"
              >
                {cat.name}
              </Link>
            ))}
          </div>
          <div className="border-t border-[#E6EAE7] pt-3 flex justify-between text-[13px] text-[#8A958E]">
            <Link href="/compare">Compare Products</Link>
          </div>
        </div>
      )}
    </header>
  );
}
