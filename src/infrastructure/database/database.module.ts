import { Global, Module } from '@nestjs/common';
import { DatabasePrivilegeCheck } from './privilege-check.js';
import { PrismaService } from './prisma.service.js';
import { ReportingDb } from './reporting-db.js';

@Global()
@Module({
  providers: [PrismaService, ReportingDb, DatabasePrivilegeCheck],
  exports: [PrismaService, ReportingDb],
})
export class DatabaseModule {}
