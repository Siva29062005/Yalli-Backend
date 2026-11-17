import { z } from 'zod';
import { Paginated } from '../interceptors/response-envelope.interceptor.js';

export const MAX_PAGE_SIZE = 60;

/** Bounded pagination: unbounded queries are impossible by construction. */
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(20),
});
export type PaginationInput = z.infer<typeof paginationSchema>;

export const skipTake = (p: PaginationInput) => ({
  skip: (p.page - 1) * p.pageSize,
  take: p.pageSize,
});

export function paginated<T>(
  items: T[],
  total: number,
  p: PaginationInput,
): Paginated<T> {
  return new Paginated(items, {
    page: p.page,
    pageSize: p.pageSize,
    total,
    totalPages: Math.ceil(total / p.pageSize),
  });
}
