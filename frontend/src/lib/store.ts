import { create } from "zustand";
import { persist } from "zustand/middleware";

interface StoreState {
  // Compare Shortlist (up to 4 products)
  compareSlugs: string[];
  addToCompare: (slug: string) => void;
  removeFromCompare: (slug: string) => void;
  clearCompare: () => void;

  // UI state
  isCartDrawerOpen: boolean;
  setCartDrawerOpen: (open: boolean) => void;
}

export const useStore = create<StoreState>()(
  persist(
    (set, get) => ({
      // Compare
      compareSlugs: [],
      addToCompare: (slug) => {
        const current = get().compareSlugs;
        if (!current.includes(slug) && current.length < 4) {
          set({ compareSlugs: [...current, slug] });
        }
      },
      removeFromCompare: (slug) => {
        set({ compareSlugs: get().compareSlugs.filter((s) => s !== slug) });
      },
      clearCompare: () => set({ compareSlugs: [] }),

      // UI
      isCartDrawerOpen: false,
      setCartDrawerOpen: (open) => set({ isCartDrawerOpen: open }),

    }),
    {
      name: "yalli-storefront-v1",
      // v2: the signed-in user moved to AuthProvider (server-backed). Drop the old fake user.
      // v3: the cart moved to the server (CartProvider). Drop the old browser-only cart and coupon.
      // v4: the wishlist moved to the server (WishlistProvider). Drop the sample wishlist and compare list.
      version: 4,
      migrate: (persisted) => {
        const rest = { ...((persisted ?? {}) as Record<string, unknown>) };
        delete rest.user;
        delete rest.cart;
        delete rest.appliedCoupon;
        delete rest.wishlistSlugs;
        delete rest.compareSlugs;
        return rest as unknown as StoreState;
      },
      partialize: (state) => ({
        compareSlugs: state.compareSlugs,
      }),
    },
  ),
);
