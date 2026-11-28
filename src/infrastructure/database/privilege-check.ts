import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '../../generated/prisma/client.js';
import type { Env } from '../../config/env.js';
import { PrismaService } from './prisma.service.js';

/**
 * The append-only and never-deleted tables, as the migrations REVOKE them from yalli_app. The migrations can only
 * revoke from a role that exists when they run: a role created later, or a broad `GRANT … ON ALL TABLES`, gives the
 * rights back. So the app checks its OWN login at start-up. Keep in step with the REVOKEs in prisma/migrations.
 */
export const FORBIDDEN_PRIVILEGES: readonly (readonly [string, string])[] = [
  ...[
    'audit_logs',
    'consents',
    'inventory_movements',
    'order_status_history',
    'payment_events',
    'order_items',
    'shipment_events',
    'credit_notes',
    'credit_note_lines',
  ].flatMap((t) =>
    ['UPDATE', 'DELETE', 'TRUNCATE'].map((p) => [t, p] as const),
  ),
  ...[
    'orders',
    'payments',
    'refunds',
    'webhook_inbox',
    'shipments',
    'document_counters',
  ].flatMap((t) => ['DELETE', 'TRUNCATE'].map((p) => [t, p] as const)),
];

/** Production refuses to start when its database login can rewrite history; elsewhere it is a warning. */
@Injectable()
export class DatabasePrivilegeCheck implements OnApplicationBootstrap {
  private readonly logger = new Logger(DatabasePrivilegeCheck.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async held(): Promise<string[]> {
    const pairs = Prisma.join(
      FORBIDDEN_PRIVILEGES.map(([t, p]) => Prisma.sql`(${t}, ${p})`),
    );
    const rows = await this.prisma.$queryRaw<{ t: string; p: string }[]>`
      SELECT x.t, x.p FROM (VALUES ${pairs}) AS x(t, p)
      WHERE to_regclass(x.t) IS NOT NULL AND has_table_privilege(current_user, x.t, x.p)`;
    return rows.map((r) => `${r.p} on ${r.t}`);
  }

  async onApplicationBootstrap(): Promise<void> {
    const production =
      this.config.get('NODE_ENV', { infer: true }) === 'production';
    let held: string[];
    try {
      held = await this.held();
    } catch (err) {
      // production fails CLOSED: an unverifiable login is not started; elsewhere (fakes, local setups) only a warning
      if (production) throw err;
      this.logger.warn(
        { err: (err as Error).name },
        'Could not check the database privileges of the app login',
      );
      return;
    }
    if (held.length === 0) return;
    const message = `The database login can ${held.join(', ')}: these tables are append-only (docs/ops/database-roles.md, "Repair")`;
    if (production) throw new Error(message);
    this.logger.warn(message);
  }
}
