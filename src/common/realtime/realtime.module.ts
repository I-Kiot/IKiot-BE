import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { RealtimeGateway } from './realtime.gateway';
import { accessTokenSecret } from '../config/env';

// Global like PrismaModule, with its own JwtModule keyed by `accessTokenSecret()` - reading JWT_SECRET directly here once made every handshake fail with "invalid signature".
@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      // ConfigService is injected only to defer the factory until `.env` is loaded - same as AuthModule.
      useFactory: (_config: ConfigService) => ({
        secret: accessTokenSecret(),
      }),
    }),
  ],
  providers: [RealtimeGateway],
  exports: [RealtimeGateway],
})
export class RealtimeModule {}
