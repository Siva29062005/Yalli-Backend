import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.js';
import { InventoryService } from './inventory.service.js';

/** Background job: returns expired reservations to stock. Disabled in tests (they call expireDue directly). */
@Injectable()
export class InventorySweeper
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(InventorySweeper.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly inventory: InventoryService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.get('BACKGROUND_JOBS_ENABLED', { infer: true })) return;
    this.timer = setInterval(() => void this.tick(), 30_000);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.running) return; // never overlap with ourselves
    this.running = true;
    try {
      const n = await this.inventory.expireDue();
      if (n > 0)
        this.logger.log(
          { expired: n },
          'Expired stock reservations returned to stock',
        );
    } catch (err) {
      this.logger.error({ err }, 'Reservation sweep failed');
    } finally {
      this.running = false;
    }
  }
}
