import { Body, Controller, HttpCode, Logger, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/access.decorators.js';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import {
  cspReportSchema,
  toViolation,
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
  // Its own budget, not the shared per-IP one: a policy mistake that fires on every page must not lock shoppers on the same
  // IP out of the shop.
  @RateLimit({
    name: 'csp-report-ip',
    limit: 30,
    windowSeconds: 60,
    key: 'ip',
    replacesGlobal: true,
  })
  receive(@Body({ schema: cspReportSchema }) body: CspReportBody): void {
    this.logger.warn(toViolation(body), 'CSP violation');
  }
}
