import { Body, Controller, Logger, Module, Post } from '@nestjs/common';
import { Public } from '../src/common/decorators/access.decorators.js';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { z } from 'zod';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { EphemeralStore } from '../src/infrastructure/cache/ephemeral-store.js';
import { InMemoryEphemeralStore } from '../src/infrastructure/cache/in-memory-ephemeral-store.js';
import { RedisService } from '../src/infrastructure/cache/redis.service.js';
import { PrismaService } from '../src/infrastructure/database/prisma.service.js';

// Test-only endpoint to exercise the global validation pipe + envelope.
const demoSchema = z
  .object({ name: z.string().min(2).max(50), email: z.email() })
  .strict();
@Public()
@Controller('demo')
class DemoController {
  @Post()
  create(@Body({ schema: demoSchema }) body: z.infer<typeof demoSchema>) {
    return { name: body.name };
  }
}
@Module({ controllers: [DemoController] })
class DemoModule {}

describe('HTTP foundation (e2e, fake infrastructure)', () => {
  beforeAll(() => Logger.overrideLogger(false));
  let app: NestExpressApplication;
  const prisma = { ping: vi.fn().mockResolvedValue(undefined) };
  const redis = { ping: vi.fn().mockResolvedValue(undefined) };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [AppModule, DemoModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(EphemeralStore)
      .useValue(new InMemoryEphemeralStore())
      .overrideProvider(RedisService)
      .useValue(redis)
      .compile();
    app = mod.createNestApplication<NestExpressApplication>({ rawBody: true });
    configureApp(app);
    await app.init();
  });
  afterAll(async () => app.close());
  beforeEach(() => {
    prisma.ping.mockResolvedValue(undefined);
    redis.ping.mockResolvedValue(undefined);
  });

  describe('health', () => {
    it('liveness is 200 and touches no dependency', async () => {
      prisma.ping.mockClear();
      await request(app.getHttpServer())
        .get('/health/live')
        .expect(200, { status: 'ok' });
      expect(prisma.ping).not.toHaveBeenCalled();
    });
    it('readiness is 200 when dependencies are up', async () => {
      const res = await request(app.getHttpServer())
        .get('/health/ready')
        .expect(200);
      expect(res.body.status).toBe('ok');
    });
    it.each([
      [
        'database',
        () => prisma.ping.mockRejectedValue(new Error('conn refused 10.1.2.3')),
      ],
      ['redis', () => redis.ping.mockRejectedValue(new Error('NOAUTH secret'))],
    ])(
      'readiness is 503 when %s is down, without leaking details',
      async (_n, breakIt) => {
        breakIt();
        const res = await request(app.getHttpServer())
          .get('/health/ready')
          .expect(503);
        expect(JSON.stringify(res.body)).not.toMatch(
          /10\.1\.2\.3|NOAUTH|secret/,
        );
      },
    );
  });

  describe('security headers', () => {
    it('sets hardening headers and hides the framework', async () => {
      const res = await request(app.getHttpServer()).get('/health/live');
      expect(res.headers['x-powered-by']).toBeUndefined();
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-security-policy']).toContain(
        "default-src 'none'",
      );
      expect(res.headers['content-security-policy']).toContain(
        "frame-ancestors 'none'",
      );
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['etag']).toBeUndefined();
    });
  });

  describe('CORS (explicit allow-list)', () => {
    it('allows a listed origin', async () => {
      const res = await request(app.getHttpServer())
        .get('/health/live')
        .set('Origin', 'https://allowed.example.com');
      expect(res.headers['access-control-allow-origin']).toBe(
        'https://allowed.example.com',
      );
    });
    it('does not allow an unlisted origin', async () => {
      const res = await request(app.getHttpServer())
        .get('/health/live')
        .set('Origin', 'https://evil.example.com');
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
    it('rejects the "null" origin and never returns a wildcard', async () => {
      const res = await request(app.getHttpServer())
        .get('/health/live')
        .set('Origin', 'null');
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('request correlation', () => {
    it('echoes a well-formed inbound request id', async () => {
      const res = await request(app.getHttpServer())
        .get('/health/live')
        .set('X-Request-Id', 'abc-12345678');
      expect(res.headers['x-request-id']).toBe('abc-12345678');
    });
    it('replaces a malformed id (log-injection defence)', async () => {
      const res = await request(app.getHttpServer())
        .get('/health/live')
        .set('X-Request-Id', 'bad id with spaces');
      expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  describe('error envelope', () => {
    it('unknown route -> 404 envelope with requestId, no framework details', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/nope')
        .expect(404);
      expect(res.body).toMatchObject({
        success: false,
        error: { code: 'NOT_FOUND' },
      });
      expect(res.body.requestId).toBe(res.headers['x-request-id']);
      expect(JSON.stringify(res.body)).not.toMatch(/Cannot GET|express|stack/i);
    });
    it('malformed JSON -> 400 envelope', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/demo')
        .set('Content-Type', 'application/json')
        .send('{"name": ')
        .expect(400);
      expect(res.body.success).toBe(false);
      expect(JSON.stringify(res.body)).not.toMatch(
        /Unexpected|position|SyntaxError/,
      );
    });
    it('oversized body -> 413 envelope', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/demo')
        .send({ name: 'x'.repeat(5_000), email: 'a@b.co' })
        .expect(413);
      expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    });
  });

  describe('validation (Zod schema pipe)', () => {
    it('accepts valid input inside the success envelope', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/demo')
        .send({ name: 'Asha', email: 'asha@example.com' })
        .expect(201);
      expect(res.body).toMatchObject({
        success: true,
        data: { name: 'Asha' },
        meta: null,
      });
    });
    it('rejects invalid input with path+message only (no echoed values)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/demo')
        .send({ name: 'A', email: 'not-an-email-SECRETVALUE' })
        .expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(JSON.stringify(res.body)).not.toContain('SECRETVALUE');
    });
    it('rejects unknown properties (mass-assignment defence)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/demo')
        .send({ name: 'Asha', email: 'asha@example.com', role: 'SUPER_ADMIN' })
        .expect(400);
      expect(res.body.success).toBe(false);
    });
  });
});
