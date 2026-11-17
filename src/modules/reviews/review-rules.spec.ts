import { describe, expect, it } from 'vitest';
import { cleanReviewText, displayName, summarise } from './review-rules.js';

describe('cleanReviewText', () => {
  it('strips markup and collapses whitespace', () => {
    const r = cleanReviewText({
      title: '<b>Great</b>   buy',
      body: 'Works <script>alert(1)</script> really   well <img src=x onerror=alert(1)>',
    });
    expect(r).toEqual({ title: 'Great buy', body: 'Works really well' });
  });
  it('rejects a body that is too short once markup is removed', () => {
    expect(cleanReviewText({ body: '<p>ok</p>' })).toBeNull();
    expect(
      cleanReviewText({ body: '<script>aaaaaaaaaaaaaaaa</script>' }),
    ).toBeNull();
  });
  it('treats an empty title as none', () => {
    expect(
      cleanReviewText({ title: '  <i></i> ', body: 'Solid and sturdy.' })
        ?.title,
    ).toBeNull();
  });
});

describe('displayName', () => {
  it('shows first name and last initial only', () => {
    expect(displayName('Asha', 'Kumar')).toBe('Asha K.');
    expect(displayName('Asha', '')).toBe('Asha');
    expect(displayName('', 'Kumar')).toBe('Customer');
  });
});

describe('summarise', () => {
  it('is empty-safe', () => {
    expect(summarise({})).toMatchObject({ count: 0, average: null });
  });
  it('computes the average to one decimal from counts', () => {
    const s = summarise({ 5: 2, 4: 1, 1: 1 }); // (10+4+1)/4 = 3.75 -> 3.8
    expect(s).toMatchObject({ count: 4, average: 3.8 });
    expect(s.distribution).toEqual({ '1': 1, '2': 0, '3': 0, '4': 1, '5': 2 });
  });
});
