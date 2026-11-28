import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import {
  APP_FILTER,
  APP_GUARD,
  APP_INTERCEPTOR,
  DiscoveryModule,
} from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import {
  LOG_REDACT_PATHS,
  serializeError,
} from './common/logging/log-safety.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { ResponseEnvelopeInterceptor } from './common/interceptors/response-envelope.interceptor.js';
import { resolveRequestId } from './common/middleware/request-id.middleware.js';
import { validateEnv, type Env } from './config/env.js';
import { AccessPolicyAuditor } from './common/guards/access-policy.auditor.js';
import {
  IpRateLimitGuard,
  PrincipalRateLimitGuard,
} from './common/guards/rate-limit.guard.js';
import { HealthModule } from './health/health.module.js';
import { AccessModule } from './modules/access/access.module.js';
import { AdminModule } from './modules/admin/admin.module.js';
import { CustomersModule } from './modules/customers/customers.module.js';
import { CatalogModule } from './modules/catalog/catalog.module.js';
import { InventoryModule } from './modules/inventory/inventory.module.js';
import { CouponsModule } from './modules/coupons/coupons.module.js';
import { CartModule } from './modules/cart/cart.module.js';
import { CommerceModule } from './modules/orders/commerce.module.js';
import { ShippingModule } from './modules/shipping/shipping.module.js';
import { ContactModule } from './modules/contact/contact.module.js';
import { CspReportsModule } from './modules/csp-reports/csp-reports.module.js';
import { ReviewsModule } from './modules/reviews/reviews.module.js';
import { OutboxModule } from './modules/outbox/outbox.module.js';
import { IdempotencyModule } from './modules/idempotency/idempotency.module.js';
import { AuditModule } from './modules/audit/audit.module.js';
import { JwtAuthGuard } from './modules/identity/guards/jwt-auth.guard.js';
import { PermissionsGuard } from './modules/identity/guards/permissions.guard.js';
import { IdentityModule } from './modules/identity/identity.module.js';
import { CacheModule } from './infrastructure/cache/cache.module.js';
import { DatabaseModule } from './infrastructure/database/database.module.js';
import { ConfigService } from '@nestjs/config';

export { LOG_REDACT_PATHS } from './common/logging/log-safety.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        const pretty = config.get('LOG_PRETTY', { infer: true });
        return {
          pinoHttp: {
            level: config.get('LOG_LEVEL', { infer: true }),
            redact: { paths: LOG_REDACT_PATHS, censor: '[REDACTED]' },
            genReqId: (req, res) => resolveRequestId(req, res),
            // Log method/url/status only; headers are redacted above and bodies are never logged.
            serializers: {
              err: serializeError,
              req: (req: { id: string; method: string; url: string }) => ({
                id: req.id,
                method: req.method,
                url: req.url.split('?')[0],
              }),
              res: (res: { statusCode: number }) => ({
                statusCode: res.statusCode,
              }),
            },
            autoLogging: {
              ignore: (req) => (req.url ?? '').startsWith('/health/'),
            },
            ...(pretty
              ? {
                  transport: {
                    target: 'pino-pretty',
                    options: { singleLine: true },
                  },
                }
              : {}),
          },
        };
      },
    }),
    DiscoveryModule,
    DatabaseModule,
    CacheModule,
    AuditModule,
    OutboxModule,
    IdempotencyModule,
    AccessModule,
    IdentityModule,
    AdminModule,
    CustomersModule,
    InventoryModule,
    CatalogModule,
    CouponsModule,
    CartModule,
    ShippingModule,
    CommerceModule,
    ReviewsModule,
    ContactModule,
    CspReportsModule,
    HealthModule,
  ],
  providers: [
    AccessPolicyAuditor,
    // Order matters: flood control -> authenticate -> authorize -> per-user limits.
    { provide: APP_GUARD, useClass: IpRateLimitGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_GUARD, useClass: PrincipalRateLimitGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
  ],
})
export class AppModule {}
