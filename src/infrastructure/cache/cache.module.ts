import { Global, Module } from '@nestjs/common';
import { EphemeralStore } from './ephemeral-store.js';
import { RedisEphemeralStore } from './redis-ephemeral-store.js';
import { RedisService } from './redis.service.js';

@Global()
@Module({
  providers: [
    RedisService,
    { provide: EphemeralStore, useClass: RedisEphemeralStore },
  ],
  exports: [RedisService, EphemeralStore],
})
export class CacheModule {}
