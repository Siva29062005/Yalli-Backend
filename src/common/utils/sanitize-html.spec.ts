import { sanitizeRichText, stripTags } from './sanitize-html.js';
import { slugify, uniqueSlug } from './slug.js';

describe('sanitizeRichText (stored XSS defence)', () => {
  it.each([
    ['<script>alert(1)</script><p>ok</p>', '<p>ok</p>'],
    ['<img src=x onerror=alert(1)>', ''],
    ['<p onclick="steal()">hi</p>', '<p>hi</p>'],
    [
      '<a href="javascript:alert(1)">x</a>',
      '<a rel="nofollow noopener noreferrer" target="_blank">x</a>',
    ],
    ['<iframe src="https://evil"></iframe>text', 'text'],
    ['<svg><script>alert(1)</script></svg>', ''],
    ['<style>body{display:none}</style>t', 't'],
    [
      '<a href="//evil.example">x</a>',
      '<a rel="nofollow noopener noreferrer" target="_blank">x</a>',
    ],
    ['<form action="/x"><input name=a></form>', ''],
  ])('neutralises %s', (input, expected) => {
    expect(sanitizeRichText(input)).toBe(expected);
  });

  it('keeps the formatting the current storefront uses', () => {
    const html =
      '<ul><li><strong>PRESERVE YOUR COOKWARE</strong> for years</li></ul><p>Tags: <em>kitchen</em></p>';
    expect(sanitizeRichText(html)).toBe(html);
  });

  it.each([
    '<a href="javascript:alert(1)">x</a>',
    '<a href="//evil.example">x</a>',
    '<a href="data:text/html,<script>alert(1)</script>">x</a>',
  ])('drops a dangerous or protocol-relative href: %s', (input) => {
    const out = sanitizeRichText(input);
    expect(out).not.toMatch(/href=/);
    expect(out).toContain('>x</a>');
  });

  it('forces safe link attributes', () => {
    expect(
      sanitizeRichText(
        '<a href="https://yalli.in" target="_self" rel="opener">x</a>',
      ),
    ).toBe(
      '<a href="https://yalli.in" target="_blank" rel="nofollow noopener noreferrer">x</a>',
    );
  });

  it('stripTags removes every tag', () => {
    expect(stripTags('<b>Bold</b> <script>x</script>name')).toBe('Bold name');
  });
});

describe('slugs', () => {
  it('produces DB-valid slugs', () => {
    expect(slugify('12 Pcs Silicone Cooking Utensils Set with Holder')).toBe(
      '12-pcs-silicone-cooking-utensils-set-with-holder',
    );
    expect(slugify('Kitchen & Dining')).toBe('kitchen-and-dining');
    expect(slugify('  Crème brûlée  ')).toBe('creme-brulee');
    expect(slugify('***')).toBe('item');
  });
  it('de-duplicates', async () => {
    const taken = new Set(['night-lamp', 'night-lamp-2']);
    expect(
      await uniqueSlug('Night Lamp', (s) => Promise.resolve(taken.has(s))),
    ).toBe('night-lamp-3');
  });
});
