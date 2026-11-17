import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.js';
import { InMemoryBus } from './in-memory-bus.js';
import { MessageBus } from './message-bus.js';
import { OutboxRelay } from './outbox-relay.js';
import { OutboxService } from './outbox.service.js';
import { RabbitMqBus } from './rabbitmq-bus.js';
import { MessageDeduplicator } from './run-once.js';

@Global()
@Module({
  providers: [
    OutboxService,
    OutboxRelay,
    MessageDeduplicator,
    {
      provide: MessageBus,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        config.get('EVENT_BUS_DRIVER', { infer: true }) === 'rabbitmq'
          ? new RabbitMqBus(config)
          : new InMemoryBus(),
    },
  ],
  exports: [OutboxService, OutboxRelay, MessageDeduplicator, MessageBus],
})
export class OutboxModule {}
