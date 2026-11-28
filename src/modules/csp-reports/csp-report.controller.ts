import { Body, Controller, HttpCode, Logger, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/access.decorators.js';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import {
  cspReportSchema,
  toViolations,
  type CspReportBody,
} from './csp-report.js';

/**
 * Receives Content-Security-Policy violation reports from shoppers' browsers (the storefront's CSP names this address
 * in `report-uri`). Anonymous by nature; bounded per IP; stores nothing; logs one sanitised line per violation
 * ("CSP violation", a CloudWatch metric filter). Used to roll the CSP out in report-only mode first on staging and to
 * notice a blocked payment or captcha script in production.
 */
@ApiTags('security')
@Controller('csp-reports')
export class CspReportController {
  private readonly logger = new Logger('CspReport');

  @Public()
  @Post()
  @HttpCode(204)
  @RateLimit({ name: 'csp-report-ip', limit: 30, windowSeconds: 60, key: 'ip' })
  receive(@Body({ schema: cspReportSchema }) body: CspReportBody): void {
    for (const v of toViolations(body).slice(0, 5))
      this.logger.warn(v, 'CSP violation');
  }
}
