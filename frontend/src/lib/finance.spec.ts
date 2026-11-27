import { describe, expect, it } from 'vitest';
import { currentIndianMonth, monthRange } from './finance';

describe('finance month ranges (India calendar months)', () => {
  it('covers the whole month in India time, December rolling into January', () => {
    expect(monthRange('2026-11')).toEqual({ from: '2026-11-01T00:00:00+05:30', to: '2026-12-01T00:00:00+05:30' });
    expect(monthRange('2026-12')).toEqual({ from: '2026-12-01T00:00:00+05:30', to: '2027-01-01T00:00:00+05:30' });
  });
  it('refuses anything that is not a month', () => {
    for (const bad of ['', '2026-13', '2026-00', '2026-1', 'abcd-ef', '2026-11-01']) expect(monthRange(bad)).toBeNull();
  });
  it('the current month is a valid month', () => {
    expect(monthRange(currentIndianMonth())).not.toBeNull();
  });
});
