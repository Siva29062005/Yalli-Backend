import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../infrastructure/database/prisma.service.js';
import { AuditAction } from '../../audit/audit-actions.js';
import { AuditService } from '../../audit/audit.service.js';
import { SecretBox } from '../crypto/secret-box.service.js';

export interface MfaRotationReport {
  mode: 'DRY_RUN' | 'APPLIED';
  scanned: number;
  alreadyCurrent: number;
  rotated: number;
  /** Changed by someone else while we worked: run again. */
  skippedConcurrent: number;
  /** MFA method ids that could not be decrypted (unknown key id or damaged data). Never contains secrets. */
  failed: string[];
}

const BATCH = 200;

/**
 * Re-encrypts every stored TOTP secret under the CURRENT key (`MFA_ENCRYPTION_KEY_ID`).
 * Rotation procedure: add the new key as current and move the old one into MFA_RETIRED_KEYS_JSON -> deploy (nobody is locked
 * out: retired keys still decrypt) -> run this with --apply -> when `alreadyCurrent` equals `scanned`, drop the retired key.
 * Safe to re-run and to run while the site is live: each row is updated only if it is unchanged since it was read.
 */
@Injectable()
export class MfaKeyRotationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly box: SecretBox,
    private readonly audit: AuditService,
  ) {}

  async run(apply: boolean): Promise<MfaRotationReport> {
    const report: MfaRotationReport = {
      mode: apply ? 'APPLIED' : 'DRY_RUN',
      scanned: 0,
      alreadyCurrent: 0,
      rotated: 0,
      skippedConcurrent: 0,
      failed: [],
    };
    let cursor: string | undefined;
    for (;;) {
      const rows = await this.prisma.mfaMethod.findMany({
        take: BATCH,
        orderBy: { id: 'asc' },
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: { id: true, userId: true, secretEnc: true },
      });
      if (rows.length === 0) break;
      cursor = rows[rows.length - 1]!.id;
      for (const row of rows) {
        report.scanned += 1;
        if (this.box.isCurrent(row.secretEnc)) {
          report.alreadyCurrent += 1;
          continue;
        }
        let sealed: string;
        try {
          sealed = this.box.reencrypt(row.secretEnc, `mfa:${row.userId}`);
        } catch {
          report.failed.push(row.id);
          continue;
        }
        if (!apply) {
          report.rotated += 1;
          continue;
        }
        const { count } = await this.prisma.mfaMethod.updateMany({
          where: { id: row.id, secretEnc: row.secretEnc },
          data: { secretEnc: sealed },
        });
        if (count === 1) report.rotated += 1;
        else report.skippedConcurrent += 1;
      }
    }
    if (apply)
      await this.audit.record({
        action: AuditAction.MfaSecretsRotated,
        outcome: report.failed.length === 0 ? 'SUCCESS' : 'FAILURE',
        actorType: 'SYSTEM',
        resourceType: 'mfa_methods',
        metadata: {
          scanned: report.scanned,
          rotated: report.rotated,
          failedCount: report.failed.length,
        },
      });
    return report;
  }
}
