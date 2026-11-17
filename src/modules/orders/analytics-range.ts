/**
 * Reporting periods are whole calendar days in India time (the shop's day), inclusive at both ends, capped at one year
 * so a request can never trigger an unbounded scan. Pure and unit-tested.
 */
export const REPORT_TZ = 'Asia/Kolkata';
export const MAX_RANGE_DAYS = 366;
export const DEFAULT_RANGE_DAYS = 30;

const IST_OFFSET_MS = 5.5 * 3_600_000;
const DAY_MS = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const parse = (d: string): number => {
  if (!DATE.test(d)) throw new RangeError('dates must be YYYY-MM-DD');
  const t = Date.parse(`${d}T00:00:00Z`);
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== d)
    throw new RangeError('invalid calendar date');
  return t;
};
const fmt = (t: number): string => new Date(t).toISOString().slice(0, 10);

export interface ReportRange {
  /** Inclusive first day (IST), YYYY-MM-DD. */
  from: string;
  /** Inclusive last day (IST), YYYY-MM-DD. */
  to: string;
  days: number;
}

export function istToday(now: Date): string {
  return fmt(now.getTime() + IST_OFFSET_MS);
}

export function resolveRange(
  from: string | undefined,
  to: string | undefined,
  now: Date = new Date(),
): ReportRange {
  const today = parse(istToday(now));
  const end = to === undefined ? today : parse(to);
  const start =
    from === undefined ? end - (DEFAULT_RANGE_DAYS - 1) * DAY_MS : parse(from);
  if (start > end) throw new RangeError('from must not be after to');
  const days = Math.round((end - start) / DAY_MS) + 1;
  if (days > MAX_RANGE_DAYS)
    throw new RangeError(`range is limited to ${MAX_RANGE_DAYS} days`);
  return { from: fmt(start), to: fmt(end), days };
}
