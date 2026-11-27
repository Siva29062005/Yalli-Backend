import { ProductRatings, type ProductRatingSource } from './product-ratings.js';

const source = (
  entries: Record<string, { average: number | null; count: number }>,
): ProductRatingSource & { ratingsFor: ReturnType<typeof vi.fn> } => ({
  ratingsFor: vi.fn(async () => new Map(Object.entries(entries))),
});

describe('ProductRatings', () => {
  it('returns an entry for every id, defaulting to no rating', async () => {
    const r = new ProductRatings();
    r.register(source({ a: { average: 4.5, count: 2 } }));
    const out = await r.forProducts(['a', 'b']);
    expect(out.get('a')).toEqual({ average: 4.5, count: 2 });
    expect(out.get('b')).toEqual({ average: null, count: 0 });
  });

  it('works with no registered source (catalogue without the reviews module)', async () => {
    const out = await new ProductRatings().forProducts(['a']);
    expect(out.get('a')).toEqual({ average: null, count: 0 });
  });

  it('does not query for an empty page', async () => {
    const r = new ProductRatings();
    const s = source({});
    r.register(s);
    expect((await r.forProducts([])).size).toBe(0);
    expect(s.ratingsFor).not.toHaveBeenCalled();
  });

  it('refuses a second, different source', () => {
    const r = new ProductRatings();
    const s = source({});
    r.register(s);
    expect(() => r.register(s)).not.toThrow();
    expect(() => r.register(source({}))).toThrow(/already registered/);
  });
});
