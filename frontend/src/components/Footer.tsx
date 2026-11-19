'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { ArrowRight, CheckCircle2 } from 'lucide-react';
import { BRAND } from '@/lib/constants';
import { useCategories } from '@/components/CategoryProvider';

export function Footer() {
  const { categories: CATEGORIES } = useCategories();
  const [email, setEmail] = useState('');
  const [subscribed, setSubscribed] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (email.trim()) {
      setSubscribed(true);
      setEmail('');
    }
  };

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
                href={`/catalog/${cat.slug}`}
                className="text-[13px] text-white/80 hover:text-white transition"
              >
                {cat.name}
              </Link>
            ))}
          </div>
        </div>
      </div>

      {/* Main Footer Row */}
      <div className="max-w-[1600px] mx-auto px-4 md:px-8 lg:px-12 py-10 md:py-12">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-center">
          {/* Left: Brand & Copyright */}
          <div className="lg:col-span-4 space-y-2">
            <span className="font-heading text-[32px] font-bold text-white tracking-tight">
              {BRAND.name}
            </span>
            <p className="text-[13px] text-white/70">
              Made for the joy of home. © 2026 Yalli
            </p>
          </div>

          {/* Center: Legal & Help Links */}
          <div className="lg:col-span-4 flex flex-wrap gap-6 text-[14px] text-white/80">
            <Link href="/help" className="hover:text-white transition">
              Help & FAQs
            </Link>
            <Link href="/shipping" className="hover:text-white transition">
              Shipping & returns
            </Link>
            <Link href="/privacy" className="hover:text-white transition">
              Privacy
            </Link>
          </div>

          {/* Right: Newsletter Signup matching Figma */}
          <div className="lg:col-span-4">
            <div className="space-y-2">
              <span className="text-[13px] text-white/90 font-medium block">
                A little goodness in your inbox
              </span>
              {subscribed ? (
                <div className="flex items-center gap-2 text-[#EEFFEE] text-[13px]">
                  <CheckCircle2 className="w-4 h-4 text-[#FF9900]" />
                  <span>Thank you for subscribing to Yalli updates!</span>
                </div>
              ) : (
                <form onSubmit={handleSubmit} className="flex gap-2">
                  <input
                    type="email"
                    required
                    placeholder="Your email address"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="min-w-0 flex-1 bg-white/10 border border-white/20 rounded-md px-3.5 py-2 text-[13px] text-white placeholder-white/40 focus:outline-none focus:border-white/50 transition"
                  />
                  <button
                    type="submit"
                    className="bg-[#FF9900] text-[#113322] font-semibold text-[13px] px-4 py-2 rounded-md hover:bg-[#e68a00] transition flex items-center gap-1.5 shrink-0"
                  >
                    <span>Sign up</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                </form>
              )}
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
}
