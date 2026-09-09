import { Global, Module } from '@nestjs/common';
import { RedisService } from './redis.service';

// Global, like RealtimeModule: one connection, injected without every feature module re-importing it.
@Global()
@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}
