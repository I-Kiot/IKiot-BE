import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { RealtimeGateway } from './realtime.gateway';
import { ChangeFeedService } from './change-feed.service';
import { accessTokenSecret } from '../config/env';

// Module realtime global, JwtModule riêng dùng `accessTokenSecret()`.
@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      // ConfigService chỉ được inject để hoãn factory tới khi `.env` đã load - giống AuthModule.
      useFactory: (_config: ConfigService) => ({
        secret: accessTokenSecret(),
      }),
    }),
  ],
  providers: [RealtimeGateway, ChangeFeedService],
  exports: [RealtimeGateway, ChangeFeedService],
})
export class RealtimeModule {}
