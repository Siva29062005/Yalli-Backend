import { Logger } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { createTestApp, type TestContext } from './support/test-app.js';

let ctx: TestContext;
beforeAll(async () => {
  Logger.overrideLogger(false);
  ctx = await createTestApp();
});
afterAll(() => ctx.close());

describe('OpenAPI document', () => {
  it('generates from the live routes, versioned under /api/v1, without exposing infrastructure endpoints', () => {
    const doc = SwaggerModule.createDocument(
      ctx.app,
      new DocumentBuilder()
        .setTitle('Yalli API')
        .setVersion('1')
        .addBearerAuth()
        .build(),
    );
    const paths = Object.keys(doc.paths);
    expect(paths).toEqual(
      expect.arrayContaining([
        '/api/v1/auth/login',
        '/api/v1/auth/register',
        '/api/v1/me',
        '/api/v1/admin/roles',
      ]),
    );
    expect(paths.some((p) => p.includes('/health') || p.includes('jwks'))).toBe(
      false,
    );
  });
});
