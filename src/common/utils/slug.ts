/** "12 Pcs Silicone Cooking Utensils Set" -> "12-pcs-silicone-cooking-utensils-set" (matches the DB slug CHECK). */
export function slugify(input: string, maxLength = 120): string {
  const slug = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  return slug || 'item';
}

export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Appends -2, -3, ... until `exists` says the slug is free. */
export async function uniqueSlug(
  base: string,
  exists: (slug: string) => Promise<boolean>,
  maxLength = 120,
): Promise<string> {
  const root = slugify(base, maxLength - 4);
  if (!(await exists(root))) return root;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${root}-${n}`;
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error('Could not allocate a unique slug');
}
