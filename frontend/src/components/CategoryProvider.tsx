'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { requestApi } from '@/lib/http';
import {
  ALL_CATEGORY,
  flattenCategories,
  type CategoryNode,
} from '@/lib/category-utils';
import type { Category } from '@/lib/types';

interface CategoryState {
  categories: Category[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

const CategoryContext = createContext<CategoryState | null>(null);

/** Refetch on window focus at most this often (the tree changes rarely; admin edits refresh the tab directly). */
const FOCUS_REFRESH_MS = 60_000;

export function CategoryProvider({
  children,
  initialTree = null,
}: {
  children: React.ReactNode;
  /** The tree as the SERVER rendered it, so names and links are in the HTML (null when the API was unavailable). */
  initialTree?: CategoryNode[] | null;
}) {
  const [categories, setCategories] = useState<Category[]>(() =>
    initialTree ? [ALL_CATEGORY, ...flattenCategories(initialTree)] : [ALL_CATEGORY],
  );
  const [loading, setLoading] = useState(initialTree === null);
  const lastLoad = useRef(0); // time of the last client load (set in effects/callbacks, never during render)
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    lastLoad.current = Date.now();
    try {
      const tree = await requestApi<CategoryNode[]>('/catalog/categories');
      setCategories([ALL_CATEGORY, ...flattenCategories(tree)]);
      setError(null);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : 'Categories are unavailable.',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Revalidate once after mount (in the background when the server already rendered the tree: no loading state), then
    // on focus, throttled. The public endpoint is browser-cacheable, so this is usually served from the cache.
    const timer = window.setTimeout(() => {
      void refresh();
    }, 0);
    const revalidate = () => {
      if (Date.now() - lastLoad.current >= FOCUS_REFRESH_MS) void refresh();
    };
    window.addEventListener('focus', revalidate);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('focus', revalidate);
    };
  }, [refresh]);

  return (
    <CategoryContext.Provider value={{ categories, loading, error, refresh }}>
      {children}
    </CategoryContext.Provider>
  );
}

export function useCategories() {
  const context = useContext(CategoryContext);
  if (!context) throw new Error('CategoryProvider is required');
  return context;
}
