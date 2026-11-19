import { adminRequest, adminRequestPage } from './admin-session';

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface AdminPageResult<T> {
  items: T[];
  meta: PageMeta;
}

type Params = Record<string, string | number | boolean | null | undefined>;

/** Builds `?a=1&b=2`, skipping empty values so the backend's strict query schemas never see blanks. */
export function queryString(params: Params = {}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

/** GET a paginated admin list (`data` = items, `meta` = paging). */
export async function adminList<T>(path: string, params: Params = {}): Promise<AdminPageResult<T>> {
  const { data, meta } = await adminRequestPage<T[]>(`${path}${queryString(params)}`);
  const m = meta ?? {};
  return {
    items: data,
    meta: {
      page: Number(m.page ?? 1),
      pageSize: Number(m.pageSize ?? data.length),
      total: Number(m.total ?? data.length),
      totalPages: Number(m.totalPages ?? 1),
    },
  };
}

export const adminGet = <T>(path: string, params: Params = {}) => adminRequest<T>(`${path}${queryString(params)}`);
export const adminPost = <T>(path: string, body?: unknown, headers?: Record<string, string>) =>
  adminRequest<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}), ...(headers ? { headers } : {}) });
export const adminPatch = <T>(path: string, body: unknown) =>
  adminRequest<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
export const adminDelete = <T = null>(path: string) => adminRequest<T>(path, { method: 'DELETE' });

/** Unsafe admin endpoints (refunds) require an Idempotency-Key; one key per user intent, reused on retry. */
export const newIdempotencyKey = () => crypto.randomUUID();

/** Rupees typed by staff -> integer paise. Returns null for anything that is not a plain amount with at most 2 decimals. */
export function rupeesToPaise(text: string): number | null {
  const t = text.trim();
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(t)) return null;
  const [whole, frac = ''] = t.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

export const paiseToRupees = (paise: number | null | undefined): string =>
  paise === null || paise === undefined ? '' : (paise / 100).toFixed(2);
