/** The current month in India time, as "YYYY-MM" (the value of an <input type="month">). */
export function currentIndianMonth(): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit' }).formatToParts(new Date());
  return `${parts.find((p) => p.type === 'year')!.value}-${parts.find((p) => p.type === 'month')!.value}`;
}

/** A filing month as an India-time range [first day 00:00, next month's first day 00:00). */
export function monthRange(month: string): { from: string; to: string } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return null;
  const year = Number(m[1]);
  const mon = Number(m[2]);
  if (mon < 1 || mon > 12) return null;
  const next = mon === 12 ? { y: year + 1, m: 1 } : { y: year, m: mon + 1 };
  const pad = (n: number) => String(n).padStart(2, '0');
  return { from: `${year}-${pad(mon)}-01T00:00:00+05:30`, to: `${next.y}-${pad(next.m)}-01T00:00:00+05:30` };
}
