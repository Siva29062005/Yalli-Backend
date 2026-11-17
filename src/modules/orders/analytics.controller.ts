import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import {
  RequirePermissions,
  RequireStepUp,
} from '../../common/decorators/access.decorators.js';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import { ErrorCode } from '../../common/exceptions/error-codes.js';
import { Permission } from '../access/permissions.js';
import { AnalyticsService } from './analytics.service.js';

const day = z.iso.date();
const rangeSchema = z
  .object({ from: day.optional(), to: day.optional() })
  .strict();
const topSchema = rangeSchema
  .extend({
    limit: z.coerce.number().int().min(1).max(50).default(10),
    by: z.enum(['revenue', 'units']).default('revenue'),
  })
  .strict();

/** A bad range is the caller's mistake: 400, never a 500. */
async function guard<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof RangeError)
      throw new BadRequestException({
        message: e.message,
        code: ErrorCode.ValidationFailed,
      });
    throw e;
  }
}

@ApiTags('admin-analytics')
@Controller('admin/analytics')
@RequireStepUp(1800)
@RequirePermissions(Permission.AnalyticsRead)
@RateLimit({
  name: 'admin-analytics',
  limit: 60,
  windowSeconds: 60,
  key: 'principal',
})
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('overview')
  overview(@Query({ schema: rangeSchema }) q: z.infer<typeof rangeSchema>) {
    return guard(() => this.analytics.overview(q.from, q.to));
  }

  @Get('sales-by-day')
  salesByDay(@Query({ schema: rangeSchema }) q: z.infer<typeof rangeSchema>) {
    return guard(() => this.analytics.salesByDay(q.from, q.to));
  }

  @Get('top-products')
  top(@Query({ schema: topSchema }) q: z.infer<typeof topSchema>) {
    return guard(() => this.analytics.topProducts(q.from, q.to, q.limit, q.by));
  }

  @Get('gst-summary')
  gst(@Query({ schema: rangeSchema }) q: z.infer<typeof rangeSchema>) {
    return guard(() => this.analytics.gstSummary(q.from, q.to));
  }
}
