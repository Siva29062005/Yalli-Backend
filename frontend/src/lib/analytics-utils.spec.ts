import { describe, expect, it } from 'vitest';
import { axisTicks, inclusiveDays, istToday, presetRange, rangeProblem, shiftDay } from './analytics-utils';

describe('shop-day ranges', () => {
  it('uses the India calendar day, not the UTC day', () => {
    expect(istToday(new Date('2026-11-18T20:00:00Z'))).toBe('2026-11-19'); // 01:30 IST next day
    expect(istToday(new Date('2026-11-18T18:29:00Z'))).toBe('2026-11-18');
  });

  it('builds inclusive presets', () => {
    const now = new Date('2026-11-19T06:00:00Z');
    expect(presetRange(1, now)).toEqual({ from: '2026-11-19', to: '2026-11-19' });
    expect(presetRange(30, now)).toEqual({ from: '2026-10-21', to: '2026-11-19' });
    expect(inclusiveDays('2026-10-21', '2026-11-19')).toBe(30);
    expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('rejects ranges the API refuses', () => {
    expect(rangeProblem('2026-11-19', '2026-11-01')).toMatch(/not be after/);
    expect(rangeProblem('2025-01-01', '2026-11-19')).toMatch(/at most 366/);
    expect(rangeProblem('', '2026-11-19')).toMatch(/both dates/);
    expect(rangeProblem('2026-01-01', '2026-11-19')).toBeNull();
  });
});

describe('axisTicks', () => {
  it('starts at zero and ends at or above the maximum, in whole-rupee steps', () => {
    for (const max of [0, 1, 99, 50_00, 138_000, 7_654_321, 12_345_678_900]) {
      const t = axisTicks(max);
      expect(t[0]).toBe(0);
      expect(t.at(-1)!).toBeGreaterThanOrEqual(max);
      expect(t.every((v) => Number.isInteger(v) && v % 100 === 0)).toBe(true);
      expect(t.length).toBeLessThanOrEqual(6);
    }
  });

  it('picks clean steps', () => {
    expect(axisTicks(138_000)).toEqual([0, 50_000, 100_000, 150_000]); // ₹0, 500, 1,000, 1,500
    expect(axisTicks(0)).toEqual([0, 100]);
  });
});
