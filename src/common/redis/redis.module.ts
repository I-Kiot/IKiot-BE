import { Global, Module } from '@nestjs/common';
import { RedisService } from './redis.service';

// Global như RealtimeModule: một kết nối duy nhất, được inject mà không cần mọi feature module import lại.
@Global()
@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}
