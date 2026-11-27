'use client';

import React from 'react';
import { useAdminSession } from '@/components/AdminContext';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ADMIN_SCREENS, canOpen } from '@/lib/admin-access';
import {
  LayoutDashboard,
  Package,
  Boxes,
  FolderTree,
  ShoppingCart,
  RotateCcw,
  Users,
  Ticket,
  MessageSquare,
  Truck,
  LogOut,
} from 'lucide-react';

const ICONS: Record<string, React.ReactNode> = {
  '/admin/analytics': <LayoutDashboard className="w-5 h-5" />,
  '/admin/products': <Package className="w-5 h-5" />,
  '/admin/categories': <FolderTree className="w-5 h-5" />,
  '/admin/inventory': <Boxes className="w-5 h-5" />,
  '/admin/orders': <ShoppingCart className="w-5 h-5" />,
  '/admin/refunds': <RotateCcw className="w-5 h-5" />,
  '/admin/reviews': <MessageSquare className="w-5 h-5" />,
  '/admin/users': <Users className="w-5 h-5" />,
  '/admin/coupons': <Ticket className="w-5 h-5" />,
  '/admin/shipping': <Truck className="w-5 h-5" />,
};

export function AdminSidebar() {
  const pathname = usePathname();
  const { identity, signOut } = useAdminSession();

  return (
    <aside className="w-full md:w-56 lg:w-64 bg-[#113322] text-white flex flex-col justify-between p-4 md:p-6 shrink-0 md:min-h-screen">
      <div className="space-y-8">
        {/* Logo & Admin Badge matching Figma Screen 24 */}
        <div className="flex items-center gap-3">
          <Link
            href="/"
            className="font-heading text-2xl font-bold tracking-tight text-white"
          >
            yalli
          </Link>
          <span className="bg-white/10 text-white/90 text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider border border-white/20">
            Admin
          </span>
        </div>

        {/* Nav Items */}
        <div className="grid grid-cols-2 gap-1 md:block md:space-y-1">
          <span className="text-[11px] font-bold text-white/40 uppercase tracking-wider block px-3 mb-2">
            Workspace
          </span>
          {ADMIN_SCREENS.filter((item) => canOpen(identity.permissions, item)).map((item) => {
            const isActive = pathname.startsWith(item.href);
            return (
              <Link
                key={item.name}
                href={item.href}
                className={`flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-[14px] font-medium transition ${
                  isActive
                    ? 'bg-[#116644] text-white shadow-xs'
                    : 'text-white/70 hover:text-white hover:bg-white/5'
                }`}
              >
                {ICONS[item.href]}
                <span>{item.name}</span>
              </Link>
            );
          })}
        </div>
      </div>

      {/* Footer Area */}
      <div className="space-y-4 pt-6 border-t border-white/10">
        <div className="bg-white/5 rounded-2xl p-4 border border-white/10 space-y-1">
          <span className="text-[12px] font-semibold text-white/90 block">
            A hand when you need it.
          </span>
          <Link
            href="/help"
            className="text-[12px] text-[#FF9900] hover:underline flex items-center gap-1 font-medium"
          >
            <span>Visit the help centre</span>
            <span>↗</span>
          </Link>
        </div>

        <div className="flex items-center justify-between text-[12px] text-white/60">
          <div>
            <span className="font-semibold text-white block break-all">{identity.email}</span>
            <span>{identity.roles.filter((role) => role !== 'CUSTOMER').join(', ')}</span>
          </div>
          <button
            type="button"
            onClick={() => void signOut()}
            className="hover:text-white p-1 shrink-0"
            aria-label="Sign out of admin"
            title="Sign out of admin"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>
    </aside>
  );
}
