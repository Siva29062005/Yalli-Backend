'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
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

export function CategoryProvider({ children }: { children: React.ReactNode }) {
  const [categories, setCategories] = useState<Category[]>([ALL_CATEGORY]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
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
    // Defer initial loading; subsequent refreshes are driven by external focus events.
    const timer = window.setTimeout(() => {
      void refresh();
    }, 0);
    const revalidate = () => {
      void refresh();
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
