import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of } from 'rxjs';
import {
  Paginated,
  ResponseEnvelopeInterceptor,
} from './response-envelope.interceptor.js';

function ctx(meta: Record<string, unknown> = {}): ExecutionContext {
  const handler = () => undefined;
  return {
    getType: () => 'http',
    getHandler: () => handler,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => ({ id: 'rid-12345678' }) }),
    ...meta,
  } as unknown as ExecutionContext;
}

describe('ResponseEnvelopeInterceptor', () => {
  const make = (reflected?: { message?: string; skip?: boolean }) => {
    const reflector = new Reflector();
    vi.spyOn(reflector, 'getAllAndOverride').mockImplementation(
      (key: unknown) =>
        key === 'response:skip-envelope' ? reflected?.skip : reflected?.message,
    );
    return new ResponseEnvelopeInterceptor(reflector);
  };
  const next = (v: unknown): CallHandler => ({ handle: () => of(v) });

  it('wraps data in the standard envelope', async () => {
    const out = (await lastValueFrom(
      make().intercept(ctx(), next({ id: 1 })),
    )) as Record<string, unknown>;
    expect(out).toMatchObject({
      success: true,
      data: { id: 1 },
      meta: null,
      requestId: 'rid-12345678',
    });
    expect(out['message']).toBe('Operation completed successfully');
    expect(Number.isNaN(Date.parse(out['timestamp'] as string))).toBe(false);
  });

  it('turns undefined into null data', async () => {
    const out = (await lastValueFrom(
      make().intercept(ctx(), next(undefined)),
    )) as Record<string, unknown>;
    expect(out['data']).toBeNull();
  });

  it('puts pagination into meta', async () => {
    const out = (await lastValueFrom(
      make().intercept(
        ctx(),
        next(new Paginated([1, 2], { page: 1, pageSize: 2, total: 5 })),
      ),
    )) as Record<string, unknown>;
    expect(out['data']).toEqual([1, 2]);
    expect(out['meta']).toEqual({ page: 1, pageSize: 2, total: 5 });
  });

  it('honours custom message and skip', async () => {
    const custom = (await lastValueFrom(
      make({ message: 'Created' }).intercept(ctx(), next({})),
    )) as Record<string, unknown>;
    expect(custom['message']).toBe('Created');
    const skipped = await lastValueFrom(
      make({ skip: true }).intercept(ctx(), next({ status: 'ok' })),
    );
    expect(skipped).toEqual({ status: 'ok' });
  });
});
