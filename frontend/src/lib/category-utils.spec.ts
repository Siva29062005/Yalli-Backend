import { describe, expect, it } from 'vitest';
import {
  canDeleteCategory,
  categorySlug,
  flattenCategories,
  parentOptions,
  type AdminCategory,
} from './category-utils';

const category = (
  id: string,
  parentId: string | null = null,
): AdminCategory => ({
  id,
  parentId,
  name: id,
  slug: id,
  position: 0,
  isActive: true,
  _count: { products: 0, children: 0 },
});

describe('category presentation rules', () => {
  it('flattens arbitrarily many categories without dropping children or counts', () => {
    const children = Array.from({ length: 40 }, (_, index) =>
      category(`child-${index}`),
    );
    const result = flattenCategories([
      { ...category('root'), productCount: 12, children },
    ]);
    expect(result).toHaveLength(41);
    expect(result[0]?.productCount).toBe(12);
    expect(result[40]?.slug).toBe('child-39');
  });
  it('generates URL-safe slugs and caps their length', () => {
    expect(categorySlug('  Café & Kitchen  ')).toBe('cafe-kitchen');
    expect(categorySlug('a'.repeat(140))).toHaveLength(120);
    expect(categorySlug('---')).toBe('');
  });
  it('excludes the category and descendants from parent options, even out of order', () => {
    expect(
      parentOptions(
        [
          category('grandchild', 'child'),
          category('child', 'root'),
          category('root'),
          category('other'),
        ],
        'root',
      ).map((row) => row.id),
    ).toEqual(['other']);
  });
  it('only offers deletion for empty leaf categories', () => {
    expect(canDeleteCategory(category('empty'))).toBe(true);
    expect(
      canDeleteCategory({
        ...category('used'),
        _count: { products: 1, children: 0 },
      }),
    ).toBe(false);
    expect(
      canDeleteCategory({
        ...category('parent'),
        _count: { products: 0, children: 1 },
      }),
    ).toBe(false);
  });
});
