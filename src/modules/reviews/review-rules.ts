import { stripTags } from '../../common/utils/sanitize-html.js';

export const REVIEW_BODY_MIN = 10;

/** Reviews are plain text: all markup is removed on write. Returns null when too little text remains. */
export function cleanReviewText(input: {
  title?: string | null | undefined;
  body: string;
}): { title: string | null; body: string } | null {
  const body = stripTags(input.body).replace(/\s+/g, ' ').trim();
  if (body.length < REVIEW_BODY_MIN) return null;
  const title = input.title
    ? stripTags(input.title).replace(/\s+/g, ' ').trim()
    : '';
  return { title: title.length > 0 ? title : null, body };
}

/** "Asha Kumar" -> "Asha K." : the public never sees a full name. */
export function displayName(first: string, last: string): string {
  const f = first.trim();
  const l = last.trim();
  if (f.length === 0) return 'Customer';
  return l.length > 0 ? `${f} ${l[0]!.toUpperCase()}.` : f;
}

export interface RatingSummary {
  count: number;
  average: number | null;
  distribution: Record<'1' | '2' | '3' | '4' | '5', number>;
}

/** Average to one decimal, computed from integer counts (no floating-point accumulation). */
export function summarise(
  counts: Partial<Record<number, number>>,
): RatingSummary {
  const distribution = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
  let count = 0;
  let sum = 0;
  for (const r of [1, 2, 3, 4, 5] as const) {
    const n = counts[r] ?? 0;
    distribution[String(r) as keyof typeof distribution] = n;
    count += n;
    sum += n * r;
  }
  return {
    count,
    average: count === 0 ? null : Math.round((sum * 10) / count) / 10,
    distribution,
  };
}
