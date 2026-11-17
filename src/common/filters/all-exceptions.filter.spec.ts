import { Logger } from '@nestjs/common';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter.js';

function run(exception: unknown) {
  const json = vi.fn();
  const res = { headersSent: false, status: vi.fn().mockReturnThis(), json };
  const req = { id: 'req-12345678', path: '/x', method: 'GET' };
  const host = {
    getType: () => 'http',
    switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }),
  } as unknown as ArgumentsHost;
  new AllExceptionsFilter().catch(exception, host);
  return {
    status: res.status.mock.calls[0]?.[0] as number,
    body: json.mock.calls[0]?.[0],
  };
}

describe('AllExceptionsFilter', () => {
  beforeAll(() => Logger.overrideLogger(false));

  it('masks unexpected errors (no message, stack or SQL leaked)', () => {
    const { status, body } = run(
      new Error(
        'select * from users where password = ... connection to 10.0.0.5 refused',
      ),
    );
    expect(status).toBe(500);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('INTERNAL_ERROR');
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/select|10\.0\.0\.5|stack|password/i);
    expect(body.requestId).toBe('req-12345678');
  });

  it('masks 5xx HttpExceptions raised with internal messages', () => {
    const { status, body } = run(new HttpException('db host leaked', 502));
    expect(status).toBe(502);
    expect(JSON.stringify(body)).not.toContain('db host leaked');
  });

  it('keeps safe client errors (4xx) with stable codes', () => {
    expect(run(new NotFoundException('Order not found')).body.error.code).toBe(
      'NOT_FOUND',
    );
    expect(run(new ForbiddenException()).status).toBe(403);
  });

  it('exposes validation issues as path+message only', () => {
    const { body } = run(
      new BadRequestException({
        message: 'Validation failed',
        issues: [
          { path: ['email'], message: 'Invalid email', input: 'secret@value' },
        ],
      }),
    );
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.details).toEqual([
      { path: 'email', message: 'Invalid email' },
    ]);
    expect(JSON.stringify(body)).not.toContain('secret@value');
  });

  it('maps body-parser style errors (413) without echoing details', () => {
    const err = Object.assign(new Error('request entity too large'), {
      status: 413,
      expose: true,
    });
    const { status, body } = run(err);
    expect(status).toBe(413);
    expect(body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('does not trust non-exposed library errors that carry a 4xx status', () => {
    const err = Object.assign(new Error('internal'), { status: 400 });
    expect(run(err).status).toBe(500);
  });
});
