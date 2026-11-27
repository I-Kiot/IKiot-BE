import { Global, Module } from '@nestjs/common';
import { RedisService } from './redis.service';

// Module Redis global, một kết nối dùng chung.
@Global()
@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}
