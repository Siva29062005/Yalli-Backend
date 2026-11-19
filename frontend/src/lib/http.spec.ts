import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadClient(browser = true) {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_API_URL', '');
  vi.stubEnv('API_INTERNAL_URL', 'http://127.0.0.1:3000/api/v1');
  vi.stubGlobal('window', browser ? {} : undefined);
  return import('./http');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('API routing', () => {
  it('sends browser login through the same-origin API proxy', async () => {
    const { requestApi } = await loadClient();
    const fetch = vi.fn().mockResolvedValue(Response.json({ success: true, data: { mfaRequired: true } }));
    vi.stubGlobal('fetch', fetch);
    await expect(requestApi('/auth/login', { method: 'POST', body: '{}' })).resolves.toEqual({ mfaRequired: true });
    expect(fetch).toHaveBeenCalledWith('/api/v1/auth/login', expect.objectContaining({ method: 'POST', credentials: 'include' }));
  });

  it('uses an absolute backend URL for server rendering', async () => {
    const { API_BASE_URL } = await loadClient(false);
    expect(API_BASE_URL).toBe('http://127.0.0.1:3000/api/v1');
  });

  it('preserves explicitly configured API URLs', async () => {
    await loadClient();
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.test/api/v1/');
    vi.resetModules();
    const { API_BASE_URL } = await import('./http');
    expect(API_BASE_URL).toBe('https://api.example.test/api/v1');
  });

  it('preserves safe backend authentication errors', async () => {
    const { requestApi } = await loadClient();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ success: false, message: 'Invalid credentials', error: { code: 'UNAUTHORIZED' } }, { status: 401 })));
    await expect(requestApi('/auth/login')).rejects.toMatchObject({ status: 401, message: 'Invalid credentials', code: 'UNAUTHORIZED' });
  });
});
