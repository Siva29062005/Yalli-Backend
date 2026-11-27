// Browsers use the same-origin proxy; server rendering needs an absolute URL.
export const API_BASE_URL = (
  process.env.NEXT_PUBLIC_API_URL ||
  (typeof window === 'undefined'
    ? process.env.API_INTERNAL_URL || 'http://127.0.0.1:3000/api/v1'
    : '/api/v1')
).replace(/\/$/, '');

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiEnvelope<T> {
  data: T;
  meta: Record<string, unknown> | null;
}

/** Like `requestApi`, but keeps the envelope `meta` (pagination) next to `data`. */
export async function requestEnvelope<T>(
  endpoint: string,
  options: RequestInit = {},
): Promise<ApiEnvelope<T>> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${endpoint}`, {
      ...options,
      credentials: 'include',
      cache: 'no-store',
      signal: options.signal ?? AbortSignal.timeout(15000),
      headers: {
        // FormData sets its own multipart boundary header.
        ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
        ...Object.fromEntries(new Headers(options.headers).entries()),
      },
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new ApiError('Unable to reach the store. Please try again.', 0);
  }
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.success) {
    throw new ApiError(
      result?.message ||
        'The request could not be completed. Please try again.',
      response.status,
      result?.error?.code,
      result?.error?.details,
    );
  }
  return { data: result.data as T, meta: (result.meta ?? null) as ApiEnvelope<T>['meta'] };
}

/** A file download (CSV export): the body as a Blob, or the API's error envelope as an ApiError. */
export async function requestBlob(endpoint: string, options: RequestInit = {}): Promise<{ blob: Blob; filename: string | null }> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${endpoint}`, {
      ...options,
      credentials: 'include',
      cache: 'no-store',
      signal: options.signal ?? AbortSignal.timeout(60000),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new ApiError('Unable to reach the store. Please try again.', 0);
  }
  if (!response.ok) {
    const result = await response.json().catch(() => null);
    throw new ApiError(result?.message || 'The file could not be downloaded. Please try again.', response.status, result?.error?.code, result?.error?.details);
  }
  // filename="…" from Content-Disposition, letters/digits/dot/dash only
  const match = /filename="([A-Za-z0-9._-]{1,100})"/.exec(response.headers.get('content-disposition') ?? '');
  return { blob: await response.blob(), filename: match?.[1] ?? null };
}

export async function requestApi<T>(
  endpoint: string,
  options: RequestInit = {},
): Promise<T> {
  return (await requestEnvelope<T>(endpoint, options)).data;
}
