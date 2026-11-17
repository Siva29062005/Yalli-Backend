import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client.js';
import type { Env } from '../../config/env.js';

/**
 * Single PrismaClient for the process (connection pool lives in the pg adapter).
 * Connects with the runtime DML-only role; schema changes use a separate migrator credential.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: ConfigService<Env, true>) {
    super({
      adapter: new PrismaPg({
        connectionString: config.get('DATABASE_URL', { infer: true }),
        max: config.get('DATABASE_POOL_MAX', { infer: true }),
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 30_000,
        statement_timeout: 15_000,
        // Every session runs in UTC. The driver sends JS Dates without an offset, so a server/session in another zone
        // (a developer laptop in IST, a differently configured RDS) would silently shift every stored timestamp.
        options: '-c timezone=UTC',
        ssl: config.get('DATABASE_SSL', { infer: true })
          ? { rejectUnauthorized: true }
          : false,
      }),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Database connection pool ready');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /** Readiness probe: cheap round-trip. */
  async ping(): Promise<void> {
    await this.$queryRaw`SELECT 1`;
  }
}
