import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client.js';
import type { Env } from '../../config/env.js';
import { PrismaService } from './prisma.service.js';

/**
 * Connection used ONLY by read-only reports. With REPORTING_DATABASE_URL it is a separate, small pool that logs in as
 * the `yalli_reporting` role (SELECT on a handful of columns, nothing else) with a short statement timeout, so a heavy or
 * malicious report can neither modify data nor read customer details, and cannot starve the transactional pool.
 * Without it (local development) reports share the normal connection.
 */
@Injectable()
export class ReportingDb implements OnModuleDestroy {
  private readonly logger = new Logger(ReportingDb.name);
  private readonly own: PrismaClient | undefined;
  /** Only raw, parameterised reads are exposed. */
  readonly client: Pick<PrismaClient, '$queryRaw'>;

  constructor(config: ConfigService<Env, true>, fallback: PrismaService) {
    const url = config.get('REPORTING_DATABASE_URL', { infer: true });
    if (!url) {
      this.client = fallback;
      return;
    }
    this.own = new PrismaClient({
      adapter: new PrismaPg({
        connectionString: url,
        max: 3,
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 30_000,
        statement_timeout: 10_000,
        options: '-c timezone=UTC -c default_transaction_read_only=on',
        ssl: config.get('DATABASE_SSL', { infer: true })
          ? { rejectUnauthorized: true }
          : false,
      }),
    });
    this.client = this.own;
    this.logger.log('Reports use the read-only reporting role');
  }

  async onModuleDestroy(): Promise<void> {
    await this.own?.$disconnect();
  }
}
