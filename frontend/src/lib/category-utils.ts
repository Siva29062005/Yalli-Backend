import type { Category } from './types';

export interface CategoryNode extends Category {
  children?: CategoryNode[];
}

export interface AdminCategory extends Category {
  parentId: string | null;
  position: number;
  isActive: boolean;
  _count: { products: number; children: number };
}

export const ALL_CATEGORY: Category = {
  id: 'all',
  name: 'All products',
  slug: 'all-products',
};

export function flattenCategories(nodes: CategoryNode[]): Category[] {
  return nodes.flatMap(({ children, ...category }) => [
    category,
    ...flattenCategories(children ?? []),
  ]);
}

export function categorySlug(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120)
    .replace(/-+$/g, '');
}

export function canDeleteCategory(category: AdminCategory): boolean {
  return category._count.products === 0 && category._count.children === 0;
}

export function parentOptions(
  categories: AdminCategory[],
  editingId?: string,
): AdminCategory[] {
  const excluded = new Set(editingId ? [editingId] : []);
  let changed = true;
  while (changed) {
    changed = false;
    for (const category of categories) {
      if (
        category.parentId &&
        excluded.has(category.parentId) &&
        !excluded.has(category.id)
      ) {
        excluded.add(category.id);
        changed = true;
      }
    }
  }
  return categories.filter((category) => !excluded.has(category.id));
}
