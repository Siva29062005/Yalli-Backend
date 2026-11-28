import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ErrorCode, STATUS_TO_CODE } from '../exceptions/error-codes.js';

const GENERIC: Record<number, string> = {
  400: 'Malformed request',
  413: 'Request body too large',
  415: 'Unsupported media type',
};

interface ErrorBody {
  success: false;
  message: string;
  error: { code: string; details?: unknown };
  timestamp: string;
  requestId: string | null;
}

/**
 * Last line of defence: every error leaves the API in the same safe shape.
 * - 5xx responses never reveal internal messages, stacks, SQL or infrastructure details.
 * - Full detail goes to the structured log, correlated by requestId.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') throw exception;
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const requestId = typeof req.id === 'string' ? req.id : null;

    const status = this.statusOf(exception);
    let message = 'An unexpected error occurred';
    let code: string = ErrorCode.Internal;
    let details: unknown;

    if (status < 500) {
      code = STATUS_TO_CODE[status] ?? ErrorCode.BadRequest;
      ({ message, details } = this.clientSafe(exception, status));
      code = this.explicitCode(exception) ?? code;
      if (details !== undefined)
        code = status === 400 ? ErrorCode.ValidationFailed : code;
    } else {
      if (status === 503) {
        code = ErrorCode.ServiceUnavailable;
        message = 'Service temporarily unavailable';
        // A 503 that WE authored (HttpException with an explicit code and message) is safe to describe; unexpected
        // errors and dependency failures stay masked.
        const authored = this.explicitCode(exception);
        if (authored && exception instanceof HttpException) {
          code = authored;
          const r = exception.getResponse();
          const m =
            typeof r === 'object' && r !== null
              ? (r as { message?: unknown }).message
              : undefined;
          if (typeof m === 'string') message = m;
        }
      }
      const logCtx = { requestId, path: req.path, method: req.method };
      if (status === 503) this.logger.warn(logCtx, 'Service unavailable');
      else
        this.logger.error(
          { err: exception, ...logCtx },
          'Unhandled server error',
        );
    }

    if (res.headersSent) return;
    // A route may have set a public Cache-Control before it failed (Nest applies @Header before the handler): an error
    // must never be cached by a browser or CloudFront.
    res.setHeader('Cache-Control', 'no-store');
    const body: ErrorBody = {
      success: false,
      message,
      error: details === undefined ? { code } : { code, details },
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(status).json(body);
  }

  /** Application code (UPPER_SNAKE) supplied by our own exceptions, e.g. STEP_UP_REQUIRED. */
  private explicitCode(exception: unknown): string | undefined {
    if (!(exception instanceof HttpException)) return undefined;
    const r = exception.getResponse();
    const c =
      typeof r === 'object' && r !== null
        ? (r as { code?: unknown }).code
        : undefined;
    return typeof c === 'string' && /^[A-Z][A-Z0-9_]{2,40}$/.test(c)
      ? c
      : undefined;
  }

  private statusOf(exception: unknown): number {
    if (exception instanceof HttpException) return exception.getStatus();
    // body-parser / http-errors style errors (413, 400 malformed JSON, 415, ...)
    const e = exception as {
      status?: unknown;
      statusCode?: unknown;
      expose?: unknown;
    } | null;
    const s = e?.status ?? e?.statusCode;
    if (typeof s === 'number' && s >= 400 && s < 500 && e?.expose === true)
      return s;
    return HttpStatus.INTERNAL_SERVER_ERROR;
  }

  private clientSafe(
    exception: unknown,
    status: number,
  ): { message: string; details?: unknown } {
    if (exception instanceof HttpException) {
      // Errors raised by the framework/parsers (bad JSON, router misses) carry internals in their
      // message; replace them with fixed text. Application-authored messages pass through.
      const cause = exception.cause as
        { expose?: unknown; type?: unknown } | undefined;
      const fromParser =
        cause instanceof SyntaxError ||
        cause?.expose !== undefined ||
        cause?.type !== undefined;
      if (fromParser)
        return { message: GENERIC[status] ?? 'Request could not be processed' };
      if (
        status === 404 &&
        /^Cannot (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) /.test(
          exception.message,
        )
      ) {
        return { message: 'Resource not found' };
      }
      const r = exception.getResponse();
      if (typeof r === 'string') return { message: r };
      const o = r as { message?: unknown; issues?: unknown; error?: unknown };
      const issues =
        o.issues ?? (Array.isArray(o.message) ? o.message : undefined);
      const message =
        typeof o.message === 'string'
          ? o.message
          : status === 400
            ? 'Validation failed'
            : exception.message;
      return issues === undefined
        ? { message }
        : { message, details: this.sanitizeIssues(issues) };
    }
    return { message: GENERIC[status] ?? 'Request could not be processed' };
  }

  /** Keep only path + message of validation issues (never echo submitted values). */
  private sanitizeIssues(issues: unknown): unknown {
    if (!Array.isArray(issues)) return undefined;
    return issues.slice(0, 50).map((i: unknown) => {
      if (typeof i === 'string') return { message: i };
      const o = i as { path?: unknown; message?: unknown };
      return {
        path: Array.isArray(o.path)
          ? o.path
              .map((p) =>
                typeof p === 'object' && p !== null && 'key' in p
                  ? String((p as { key: unknown }).key)
                  : String(p),
              )
              .join('.')
          : undefined,
        message: typeof o.message === 'string' ? o.message : 'Invalid value',
      };
    });
  }
}
