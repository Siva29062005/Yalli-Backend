"use client";

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/components/AuthProvider";
import { displayName } from "@/lib/customer-session";

interface NavItem {
  name: string;
  href: string;
}

const NAV_ITEMS: NavItem[] = [
  { name: "My orders", href: "/account/orders" },
  { name: "Profile", href: "/account/profile" },
  { name: "Addresses", href: "/account/addresses" },
  { name: "Sessions", href: "/account/sessions" },
  { name: "Wishlist", href: "/account/wishlist" },
  { name: "My Reviews", href: "/account/reviews" },
  { name: "My returns", href: "/account/returns" },
];

export function AccountSidebar() {
  const pathname = usePathname();
  const { user, logout } = useAuth();
  const name = user ? displayName(user) : "";
  const initials =
    name
      .split(/\s+/)
      .map((part) => part[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() || "Y";

  return (
    <>
    {/* Phones/tablets: a compact, horizontally scrollable tab row so page content is visible first. */}
    <nav aria-label="Account sections" className="lg:hidden -mx-4 w-[calc(100%+2rem)] min-w-0 md:-mx-8 md:w-[calc(100%+4rem)]">
      <ul className="flex gap-2 overflow-x-auto px-4 pb-1 md:px-8 [scrollbar-width:none]">
        {NAV_ITEMS.map((item) => {
          const isActive = pathname.startsWith(item.href);
          return (
            <li key={item.name} className="shrink-0">
              <Link
                href={item.href}
                aria-current={isActive ? 'page' : undefined}
                className={`block whitespace-nowrap rounded-full border px-4 py-2 text-[13px] font-medium transition ${
                  isActive
                    ? 'border-[#116644] bg-[#116644] text-white'
                    : 'border-[#E0EFE5] bg-white text-[#4A5550] hover:text-[#113322]'
                }`}
              >
                {item.name}
              </Link>
            </li>
          );
        })}
        <li className="shrink-0">
          <button
            type="button"
            onClick={() => logout('/')}
            className="whitespace-nowrap rounded-full border border-[#E0EFE5] bg-white px-4 py-2 text-[13px] font-medium text-[#8A958E] hover:text-red-600"
          >
            Log out
          </button>
        </li>
      </ul>
    </nav>
    <aside className="hidden lg:block w-64 bg-[#F2F5F3]/70 rounded-3xl p-6 border border-[#E0EFE5] space-y-6 shrink-0">
      {/* User Avatar & Name matching Figma Screen 09/16 */}
      <div className="flex items-center gap-3 pb-4 border-b border-[#E0EFE5]">
        <div
          aria-hidden
          className="w-12 h-12 shrink-0 rounded-full bg-[#116644] text-white font-heading font-bold text-[16px] flex items-center justify-center"
        >
          {initials}
        </div>
        <div className="min-w-0">
          <span className="font-heading text-[15px] font-bold text-[#113322] block leading-tight truncate">
            {name}
          </span>
          <span className="text-[12px] text-[#8A958E] block truncate">{user?.email}</span>
        </div>
      </div>

      {/* Navigation Links matching Figma Sidebar */}
      <nav className="space-y-1">
        {NAV_ITEMS.map((item) => {
          const isActive = pathname.startsWith(item.href);
          return (
            <Link
              key={item.name}
              href={item.href}
              className={`block px-4 py-2.5 rounded-xl text-[14px] font-medium transition ${
                isActive
                  ? "bg-[#116644] text-white shadow-xs"
                  : "text-[#4A5550] hover:text-[#113322] hover:bg-white/60"
              }`}
            >
              {item.name}
            </Link>
          );
        })}
      </nav>

      {/* Logout */}
      <div className="pt-4 border-t border-[#E0EFE5]">
        <button
          onClick={() => logout("/")}
          type="button"
          className="text-[13px] font-medium text-[#8A958E] hover:text-red-600 transition flex items-center gap-1"
        >
          <span>Log out</span>
          <span>↗</span>
        </button>
      </div>
    </aside>
    </>
  );
}
