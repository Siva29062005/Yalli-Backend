import { describe, expect, it } from 'vitest';
import { istToday, resolveRange } from './analytics-range.js';

// 2026-11-17 20:00 UTC is already 2026-11-18 01:30 in India.
const now = new Date('2026-11-17T20:00:00Z');

describe('resolveRange', () => {
  it("uses India's calendar day, not UTC's", () => {
    expect(istToday(now)).toBe('2026-11-18');
    expect(istToday(new Date('2026-11-17T18:29:59Z'))).toBe('2026-11-17');
    expect(istToday(new Date('2026-11-17T18:30:00Z'))).toBe('2026-11-18');
  });
  it('defaults to the last 30 days ending today (inclusive)', () => {
    expect(resolveRange(undefined, undefined, now)).toEqual({
      from: '2026-10-20',
      to: '2026-11-18',
      days: 30,
    });
  });
  it('accepts explicit bounds, single days and a full leap year', () => {
    expect(resolveRange('2026-11-01', '2026-11-01', now).days).toBe(1);
    expect(() => resolveRange('2023-12-31', '2024-12-31', now)).toThrow(
      /limited/,
    ); // 367 days
    expect(resolveRange('2024-01-01', '2024-12-31', now).days).toBe(366);
  });
  it('rejects inverted, oversized and malformed ranges', () => {
    expect(() => resolveRange('2026-11-10', '2026-11-01', now)).toThrow(
      /after/,
    );
    expect(() => resolveRange('2025-01-01', '2026-11-01', now)).toThrow(
      /limited/,
    );
    expect(() => resolveRange('2026-02-30', '2026-03-01', now)).toThrow(
      /invalid/,
    );
    expect(() => resolveRange('11/01/2026', undefined, now)).toThrow(
      /YYYY-MM-DD/,
    );
  });
});
