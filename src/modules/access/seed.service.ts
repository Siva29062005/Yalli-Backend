import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { AuditAction } from '../audit/audit-actions.js';
import { AuditService } from '../audit/audit.service.js';
import { ALL_PERMISSIONS, ROLE_DEFINITIONS, RoleName } from './permissions.js';

/** Arbitrary constant namespace for this application's seed lock. */
const SEED_LOCK_ID = 727_001;

@Injectable()
export class SeedService {
  private readonly logger = new Logger(SeedService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Idempotently makes the database match permissions.ts. System roles are reset to their definition on every run,
   * so manual drift (a permission quietly added to a role) is corrected and shows up in review, not in production.
   */
  async syncRolesAndPermissions(): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // Serialise concurrent runs (e.g. several instances seeding during a rolling deploy). Released at commit.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SEED_LOCK_ID})`;
      for (const name of ALL_PERMISSIONS) {
        await tx.permission.upsert({
          where: { name },
          update: {},
          create: { name },
        });
      }
      const permissions = await tx.permission.findMany({
        select: { id: true, name: true },
      });
      const permId = new Map(permissions.map((p) => [p.name, p.id]));

      for (const [name, def] of Object.entries(ROLE_DEFINITIONS)) {
        const role = await tx.role.upsert({
          where: { name },
          update: { rank: def.rank, description: def.description },
          create: { name, rank: def.rank, description: def.description },
        });
        await tx.rolePermission.deleteMany({ where: { roleId: role.id } });
        await tx.rolePermission.createMany({
          data: def.permissions.map((p) => ({
            roleId: role.id,
            permissionId: permId.get(p)!,
          })),
        });
      }
    });
    this.logger.log(
      `Synced ${ALL_PERMISSIONS.length} permissions and ${Object.keys(ROLE_DEFINITIONS).length} roles`,
    );
  }

  /** The single physical warehouse today (Madurai). The model supports more; only one may be the default. */
  async ensureDefaultWarehouse(): Promise<void> {
    const existing = await this.prisma.warehouse.findFirst({
      where: { isDefault: true },
    });
    if (existing) return;
    try {
      await this.prisma.warehouse.upsert({
        where: { code: 'MDU-01' },
        update: { isDefault: true, isActive: true },
        create: { code: 'MDU-01', name: 'Madurai warehouse', isDefault: true },
      });
    } catch (err) {
      // A concurrent seeder created it first (unique code / one-default index): that is the desired end state.
      if ((err as { code?: string }).code !== 'P2002') throw err;
    }
  }

  /** Creates the first SUPER_ADMIN only when none exists. The caller supplies a password that passed the policy. */
  async bootstrapSuperAdmin(
    email: string,
    passwordHash: string,
  ): Promise<'created' | 'already-exists'> {
    const existing = await this.prisma.userRole.count({
      where: { role: { name: RoleName.SuperAdmin } },
    });
    if (existing > 0) return 'already-exists';

    const [superAdmin, customer] = await Promise.all([
      this.prisma.role.findUniqueOrThrow({
        where: { name: RoleName.SuperAdmin },
      }),
      this.prisma.role.findUniqueOrThrow({
        where: { name: RoleName.Customer },
      }),
    ]);
    const user = await this.prisma.user.create({
      data: {
        email,
        emailNormalized: email.toLowerCase(),
        passwordHash,
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
        customer: {
          create: { firstName: 'System', lastName: 'Administrator' },
        },
        roles: { create: [{ roleId: superAdmin.id }, { roleId: customer.id }] },
      },
      select: { id: true },
    });
    await this.audit.record({
      action: AuditAction.BootstrapAdminCreated,
      outcome: 'SUCCESS',
      actorType: 'SYSTEM',
      resourceType: 'user',
      resourceId: user.id,
    });
    return 'created';
  }
}
