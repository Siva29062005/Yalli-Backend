'use client';
import { ALL_CATEGORY } from '@/lib/category-utils';

import React from 'react';
import Link from 'next/link';
import {
  LayoutGrid,
  Smartphone,
  Home,
  Utensils,
  Sparkles,
  Compass,
  HeartPulse,
  Award,
} from 'lucide-react';
import { useCategories } from '@/components/CategoryProvider';

const ICON_MAP: Record<string, React.ReactNode> = {
  all: <LayoutGrid className="w-6 h-6 text-[#116644]" />,
  'electronics-gadgets': <Smartphone className="w-6 h-6 text-[#116644]" />,
  'home-accessories': <Home className="w-6 h-6 text-[#116644]" />,
  'kitchen-dining': <Utensils className="w-6 h-6 text-[#116644]" />,
  combo: <Sparkles className="w-6 h-6 text-[#FF9900]" />,
  'outdoor-travel': <Compass className="w-6 h-6 text-[#116644]" />,
  'health-wellness': <HeartPulse className="w-6 h-6 text-[#116644]" />,
  'yalli-products': <Award className="w-6 h-6 text-[#116644]" />,
};

export function CategoryTiles() {
  const { categories: CATEGORIES, loading, error, refresh } = useCategories();
  return (
    <section className="py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="font-heading text-[22px] md:text-[26px] font-bold text-[#113322]">
            Find your kind of living
          </h2>
          <p className="text-[13px] text-[#5F6B64]">
            Explore thoughtfully chosen collections for modern homes
          </p>
        </div>
        <Link
          href="/catalog"
          className="text-[13px] font-semibold text-[#116644] hover:underline"
        >
          View all categories →
        </Link>
      </div>

      {loading && (
        <p role="status" className="mb-4 text-sm text-[#4A5550]">
          Loading categories…
        </p>
      )}
      {error && (
        <div
          role="status"
          className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm"
        >
          Categories are temporarily unavailable.{' '}
          <button
            type="button"
            onClick={() => void refresh()}
            className="font-semibold underline"
          >
            Try again
          </button>
        </div>
      )}
      {!loading && !error && CATEGORIES.length === 1 && (
        <p className="mb-4 text-sm text-[#4A5550]">
          New collections are on their way.
        </p>
      )}
      {/* Category cards wrap as the catalogue grows. */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3 md:gap-4">
        {CATEGORIES.map((cat) => (
          <Link
            key={cat.id}
            href={cat.id === ALL_CATEGORY.id ? '/catalog' : `/catalog/${cat.slug}`}
            className="group bg-white rounded-2xl p-4 border border-[#E6EAE7] hover:border-[#116644] hover:shadow-md transition-all duration-200 flex flex-col items-center text-center space-y-2.5"
          >
            <div className="w-14 h-14 rounded-full bg-[#EEFFEE] group-hover:bg-[#116644] flex items-center justify-center transition-colors duration-200">
              <div className="group-hover:text-white transition-colors duration-200">
                {ICON_MAP[cat.id === ALL_CATEGORY.id ? 'all' : cat.slug] || (
                  <LayoutGrid className="w-6 h-6 text-[#116644]" />
                )}
              </div>
            </div>
            <span className="text-[13px] font-semibold text-[#113322] group-hover:text-[#116644] min-w-0 max-w-full [overflow-wrap:anywhere] transition">
              {cat.name}
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}
