import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { RealtimeGateway } from './realtime.gateway';
import { accessTokenSecret } from '../config/env';

// Global như PrismaModule, có JwtModule riêng khoá bằng `accessTokenSecret()` - từng đọc thẳng JWT_SECRET ở đây khiến mọi handshake lỗi "invalid signature".
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
  providers: [RealtimeGateway],
  exports: [RealtimeGateway],
})
export class RealtimeModule {}
