import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { REQUEST_ID_HEADER } from '../constants/http.js';

/** Accept an inbound correlation id only if short and well-formed (prevents log injection). */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

/** Returns the request's correlation id, creating (and echoing) one if needed. */
export function resolveRequestId(
  req: IncomingMessage & { id?: unknown },
  res: ServerResponse,
): string {
  if (typeof req.id === 'string' && SAFE_REQUEST_ID.test(req.id)) return req.id;
  const inbound = req.headers[REQUEST_ID_HEADER];
  const id =
    typeof inbound === 'string' && SAFE_REQUEST_ID.test(inbound)
      ? inbound
      : randomUUID();
  req.id = id;
  res.setHeader('X-Request-Id', id);
  return id;
}

/**
 * Must be registered BEFORE body parsers so that even parse failures / oversized bodies
 * carry a correlation id in logs and error responses.
 */
export function requestIdMiddleware(
  req: IncomingMessage & { id?: unknown },
  res: ServerResponse,
  next: (err?: unknown) => void,
): void {
  resolveRequestId(req, res);
  next();
}
