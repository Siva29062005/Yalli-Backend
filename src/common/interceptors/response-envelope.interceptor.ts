import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { Observable, map } from 'rxjs';
import {
  RESPONSE_MESSAGE_KEY,
  SKIP_ENVELOPE_KEY,
} from '../decorators/response.decorators.js';

/** Return this from a handler to attach pagination/meta information to the envelope. */
export class Paginated<T> {
  constructor(
    readonly items: T[],
    readonly meta: Record<string, unknown>,
  ) {}
}

export interface ApiEnvelope<T = unknown> {
  success: true;
  message: string;
  data: T;
  meta: Record<string, unknown> | null;
  timestamp: string;
  requestId: string | null;
}

@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(SKIP_ENVELOPE_KEY, targets))
      return next.handle();

    const message =
      this.reflector.getAllAndOverride<string>(RESPONSE_MESSAGE_KEY, targets) ??
      'Operation completed successfully';
    const req = context.switchToHttp().getRequest<Request>();

    return next.handle().pipe(
      map((result): ApiEnvelope => {
        const paginated = result instanceof Paginated;
        return {
          success: true,
          message,
          data: paginated ? result.items : (result ?? null),
          meta: paginated ? result.meta : null,
          timestamp: new Date().toISOString(),
          requestId: typeof req.id === 'string' ? req.id : null,
        };
      }),
    );
  }
}
