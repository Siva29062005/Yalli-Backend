import { describe, expect, it } from 'vitest';
import { decodeEntities, parseImportFile } from './import-file.js';

const variant = (over: Record<string, unknown> = {}) => ({
  sku: 'SKU-1',
  priceMinor: 59_000,
  stock: 5,
  ...over,
});
const product = (over: Record<string, unknown> = {}) => ({
  name: 'Momos Maker',
  categoryKeys: ['kitchen'],
  variants: [variant()],
  ...over,
});
const file = (over: Record<string, unknown> = {}) => ({
  version: 1,
  categories: [{ key: 'kitchen', name: 'Kitchen' }],
  products: [product()],
  ...over,
});
const issues = (raw: unknown) => {
  const r = parseImportFile(raw);
  if (r.ok) throw new Error('expected failure');
  return r.issues;
};

describe('parseImportFile - shape', () => {
  it('accepts a minimal file and plans parents before children', () => {
    const r = parseImportFile(
      file({
        categories: [
          { key: 'child', name: 'Storage', parentKey: 'kitchen' },
          { key: 'kitchen', name: 'Kitchen' },
        ],
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.categories.map((c) => c.key)).toEqual(['kitchen', 'child']);
      expect(r.plan.products[0]).toMatchObject({
        slug: 'momos-maker',
        status: 'DRAFT',
      });
    }
  });

  it('rejects unknown fields everywhere (strict)', () => {
    expect(parseImportFile(file({ extra: 1 })).ok).toBe(false);
    expect(
      parseImportFile(file({ products: [product({ isAdmin: true })] })).ok,
    ).toBe(false);
    expect(
      parseImportFile(
        file({ products: [product({ variants: [variant({ qty: 1 })] })] }),
      ).ok,
    ).toBe(false);
  });

  it('rejects floating-point or non-positive money, bad GST slabs, inverted sale prices and negative stock', () => {
    for (const bad of [
      variant({ priceMinor: 590.5 }),
      variant({ priceMinor: 0 }),
      variant({ priceMinor: '590' }),
      variant({ salePriceMinor: 59_000 }),
      variant({ stock: -1 }),
      variant({ stock: 1.5 }),
      variant({ sku: 'bad sku!' }),
    ])
      expect(
        parseImportFile(file({ products: [product({ variants: [bad] })] })).ok,
      ).toBe(false);
    expect(
      parseImportFile(file({ products: [product({ gstRateBps: 1700 })] })).ok,
    ).toBe(false);
    expect(
      parseImportFile(file({ products: [product({ gstRateBps: 1800 })] })).ok,
    ).toBe(true);
    expect(parseImportFile(file({ version: 2 })).ok).toBe(false);
    expect(parseImportFile(file({ products: [] })).ok).toBe(false);
  });
});

describe('parseImportFile - cross references', () => {
  it('reports unknown categories, duplicate SKUs (case-insensitive) and duplicate explicit slugs - all at once', () => {
    const found = issues(
      file({
        products: [
          product({
            categoryKeys: ['nope'],
            slug: 'same',
            variants: [variant({ sku: 'ABC' })],
          }),
          product({
            name: 'Two',
            slug: 'same',
            variants: [variant({ sku: 'abc' })],
          }),
        ],
      }),
    );
    const msgs = found.map((i) => i.message).join('|');
    expect(msgs).toContain('unknown category "nope"');
    expect(msgs).toContain('SKU "abc" is also used by');
    expect(msgs).toContain('duplicate slug "same"');
  });

  it('detects unknown parents, duplicate keys and duplicate category slugs', () => {
    const msgs = issues(
      file({
        categories: [
          { key: 'a', name: 'A' },
          { key: 'a', name: 'Dup' },
          { key: 'c', name: 'C', parentKey: 'ghost' },
          { key: 'd', name: 'Same', slug: 'same' },
          { key: 'e', name: 'Same too', slug: 'same' },
        ],
        products: [product({ categoryKeys: ['a'] })],
      }),
    )
      .map((i) => i.message)
      .join('|');
    expect(msgs).toContain('duplicate category key "a"');
    expect(msgs).toContain('unknown parent "ghost"');
    expect(msgs).toContain('duplicate category slug "same"');
  });

  it('detects category cycles', () => {
    const msgs = issues(
      file({
        categories: [
          { key: 'a', name: 'A', parentKey: 'b' },
          { key: 'b', name: 'B', parentKey: 'a' },
        ],
        products: [product({ categoryKeys: ['a'] })],
      }),
    )
      .map((i) => i.message)
      .join('|');
    expect(msgs).toContain('cycle');
  });

  it('derives unique, DETERMINISTIC slugs for products that share a name', () => {
    const raw = file({
      products: [
        product({ variants: [variant({ sku: 'A-1' })] }),
        product({ variants: [variant({ sku: 'B-1' })] }),
      ],
    });
    const slugs = (r: ReturnType<typeof parseImportFile>) =>
      r.ok ? r.plan.products.map((p) => p.slug) : [];
    const first = slugs(parseImportFile(raw));
    expect(first).toEqual(['momos-maker', 'momos-maker-b-1']);
    expect(slugs(parseImportFile(raw))).toEqual(first); // re-run finds the same products
  });
});

describe('descriptions', () => {
  it('decodes one level of entity-encoding only when asked', () => {
    const html = '&lt;p&gt;Fish &amp;amp; chips&lt;/p&gt;';
    const off = parseImportFile(
      file({ products: [product({ descriptionHtml: html })] }),
    );
    const on = parseImportFile(
      file({
        options: { decodeEntityEncodedDescriptions: true },
        products: [product({ descriptionHtml: html })],
      }),
    );
    expect(off.ok && off.plan.products[0]!.descriptionHtml).toBe(html);
    expect(on.ok && on.plan.products[0]!.descriptionHtml).toBe(
      '<p>Fish &amp; chips</p>',
    );
    expect(decodeEntities('&lt;b&gt;')).toBe('<b>');
  });
});
