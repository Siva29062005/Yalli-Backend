/** Pure helpers for the staff overview: shop-day (IST) ranges and chart axis maths. Integer paise throughout. */

const DAY_MS = 86_400_000;
const IST_OFFSET_MS = 5.5 * 3_600_000;
export const MAX_RANGE_DAYS = 366;

/** Today in India time as YYYY-MM-DD. */
export function istToday(now: Date = new Date()): string {
  return new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

export function shiftDay(day: string, delta: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + delta * DAY_MS).toISOString().slice(0, 10);
}

/** Inclusive number of days between two YYYY-MM-DD dates. */
export function inclusiveDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
}

export function presetRange(days: number, now: Date = new Date()): { from: string; to: string } {
  const to = istToday(now);
  return { from: shiftDay(to, -(days - 1)), to };
}

/** Returns an error message for a range the API would refuse, or null. */
export function rangeProblem(from: string, to: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return 'Choose both dates.';
  if (from > to) return 'The start date must not be after the end date.';
  if (inclusiveDays(from, to) > MAX_RANGE_DAYS) return `Choose a range of at most ${MAX_RANGE_DAYS} days.`;
  return null;
}

/**
 * Chart axis: about four steps of 1, 2 or 5 x 10^k rupees, so the top tick sits just above the largest value.
 * Returns the tick values in paise, starting at 0.
 */
export function axisTicks(maxMinor: number): number[] {
  const rupeeMax = Math.max(0, Math.ceil(maxMinor / 100));
  const target = Math.max(1, Math.ceil(rupeeMax / 4));
  let magnitude = 1;
  while (magnitude * 10 <= target) magnitude *= 10;
  const step = [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= target) ?? 10 * magnitude;
  const steps = Math.max(1, Math.ceil(rupeeMax / step));
  return Array.from({ length: steps + 1 }, (_, i) => i * step * 100);
}

/** Axis labels: in full under 10,000, compact above (one style per axis is the caller's choice via `compact`). */
export function formatAxisMoney(minor: number, compact: boolean): string {
  const rupees = Math.round(minor / 100);
  return compact
    ? `₹${new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 }).format(rupees)}`
    : `₹${rupees.toLocaleString('en-IN')}`;
}
