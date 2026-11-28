import {
  StandardSchemaValidationPipe,
  VersioningType,
  type INestApplication,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import {
  API_DEFAULT_VERSION,
  API_PREFIX,
  REQUEST_ID_HEADER,
  UNPREFIXED_ROUTES,
} from './common/constants/http.js';
import { requestIdMiddleware } from './common/middleware/request-id.middleware.js';
import type { Env } from './config/env.js';

/**
 * All HTTP hardening lives here so that main.ts and the e2e tests run the SAME configuration.
 */
export function configureApp(app: NestExpressApplication): void {
  const config = app.get<ConfigService<Env, true>>(ConfigService);
  const isProd = config.get('NODE_ENV', { infer: true }) === 'production';
  const origins = config.get('CORS_ALLOWED_ORIGINS', { infer: true });
  const bodyLimit = `${config.get('REQUEST_BODY_LIMIT_KB', { infer: true })}kb`;

  app.disable('x-powered-by');
  app.use(requestIdMiddleware);
  app.set('trust proxy', config.get('TRUST_PROXY_HOPS', { infer: true }));
  app.set('etag', false);
  // Nothing the API answers may be kept by a browser or a shared cache (CloudFront) unless a route says otherwise
  // (the public catalogue and media set their own Cache-Control): sessions, tokens, MFA secrets, personal data.
  app.use(
    (
      _req: unknown,
      res: { setHeader(k: string, v: string): void },
      next: () => void,
    ) => {
      res.setHeader('Cache-Control', 'no-store');
      next();
    },
  );

  // JSON API only: lock everything down (no HTML, frames, or sniffing).
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'none'"],
        },
      },
      referrerPolicy: { policy: 'no-referrer' },
      hsts: isProd
        ? { maxAge: 63_072_000, includeSubDomains: true, preload: true }
        : false,
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );

  // Explicit allow-list; an empty list means "no cross-origin access" (never wildcard).
  app.enableCors({
    origin: origins.length > 0 ? origins : false,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Idempotency-Key',
      'X-CSRF-Token',
      'X-Auth-Mode',
      'X-Cart-Token',
      REQUEST_ID_HEADER,
    ],
    exposedHeaders: ['X-Request-Id', 'Retry-After'],
    maxAge: 600,
  });

  // Small body limits; rawBody is retained for webhook signature verification (Phase 5). Browsers send CSP violation
  // reports as application/csp-report or application/reports+json (neither can be sent cross-site without a preflight).
  app.useBodyParser('json', {
    limit: bodyLimit,
    type: [
      'application/json',
      'application/csp-report',
      'application/reports+json',
    ],
  });
  app.useBodyParser('urlencoded', { limit: bodyLimit, extended: false });

  app.setGlobalPrefix(API_PREFIX, { exclude: UNPREFIXED_ROUTES });
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: API_DEFAULT_VERSION,
  });

  // Schemas decide how unknown keys are treated; our DTO schemas are `.strict()` (mass-assignment defence).
  app.useGlobalPipes(new StandardSchemaValidationPipe());
  app.enableShutdownHooks();

  if (config.get('SWAGGER_ENABLED', { infer: true })) {
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Yalli API')
        .setVersion('1')
        .addBearerAuth()
        .build(),
    );
    SwaggerModule.setup('docs', app as INestApplication, doc);
  }
}

export function applyServerTimeouts(
  server: import('node:http').Server,
  requestTimeoutMs: number,
): void {
  server.requestTimeout = requestTimeoutMs;
  server.headersTimeout = Math.min(requestTimeoutMs, 15_000);
  server.keepAliveTimeout = 65_000;
}
