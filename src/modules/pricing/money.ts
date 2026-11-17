/**
 * Money is ALWAYS an integer number of paise (INR minor units). No floats, no decimals, no strings.
 * All values stay far below Number.MAX_SAFE_INTEGER (prices are capped at 1e9 paise by a DB CHECK), and every
 * helper asserts safe integers so a bug surfaces as an exception instead of a silently wrong amount.
 */
export type Minor = number;

export const CURRENCY = 'INR' as const;

export function assertMinor(value: number, label = 'amount'): Minor {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(
      `${label} must be a non-negative safe integer (paise), got ${value}`,
    );
  return value;
}

/** round(a / b) with halves rounded UP, for non-negative integers, using integer arithmetic only. */
export function divRoundHalfUp(a: number, b: number): number {
  assertMinor(a, 'dividend');
  if (!Number.isSafeInteger(b) || b <= 0)
    throw new RangeError('divisor must be a positive safe integer');
  const twice = 2 * a + b;
  if (!Number.isSafeInteger(twice)) throw new RangeError('overflow');
  return Math.floor(twice / (2 * b));
}

export function sumMinor(values: readonly number[]): Minor {
  let total = 0;
  for (const v of values) total += assertMinor(v);
  return assertMinor(total, 'sum');
}

/** "₹1,234.50" style formatting for logs/emails (never used in arithmetic). */
export function formatInr(minor: Minor): string {
  const rupees = Math.floor(minor / 100);
  const paise = String(minor % 100).padStart(2, '0');
  return `₹${rupees.toLocaleString('en-IN')}.${paise}`;
}
