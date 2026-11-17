import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';
import { ReportingDb } from './reporting-db.js';

@Global()
@Module({
  providers: [PrismaService, ReportingDb],
  exports: [PrismaService, ReportingDb],
})
export class DatabaseModule {}
