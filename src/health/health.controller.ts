import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import {
  HealthCheck,
  HealthCheckService,
  HealthIndicatorService,
} from '@nestjs/terminus';
import { Public } from '../common/decorators/access.decorators.js';
import { SkipEnvelope } from '../common/decorators/response.decorators.js';
import { RedisService } from '../infrastructure/cache/redis.service.js';
import { PrismaService } from '../infrastructure/database/prisma.service.js';

/**
 * Probe endpoints for the orchestrator / load balancer. Responses expose only
 * up/down per dependency - no versions, hosts or error messages.
 * In production these must be reachable from the internal network only (see infra/nginx).
 */
@ApiExcludeController()
@Public()
@SkipEnvelope()
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly indicator: HealthIndicatorService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /** Liveness: the process is running. Must not touch dependencies. */
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  /** Readiness: dependencies required to serve traffic are reachable. */
  @Get('ready')
  @HealthCheck()
  ready() {
    return this.health.check([
      () => this.probe('database', () => this.prisma.ping()),
      () => this.probe('redis', () => this.redis.ping()),
    ]);
  }

  private async probe(key: string, fn: () => Promise<void>) {
    const check = this.indicator.check(key);
    try {
      await fn();
      return check.up();
    } catch {
      return check.down();
    }
  }
}
