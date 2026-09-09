import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { accessTokenSecret } from '../../common/config/env';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { OtpService } from './otp.service';
import { RefreshTokenService } from './refresh-token.service';
import { EsmsService } from './esms.service';
import { FirebaseModule } from '../../common/firebase/firebase.module';
import { WorkingScheduleModule } from '../working-schedules/working-schedules.module';

@Module({
  imports: [
    PassportModule,
    // Shared with PushService - one Firebase Admin app for the whole process.
    FirebaseModule,
    // JwtStrategy resolves shift-supervisor rights on every request - see its comment.
    WorkingScheduleModule,
    /** `registerAsync` so the factory runs after ConfigModule has read `.env` - a synchronous `register()` would sign with an empty secret - and the key comes from `accessTokenSecret()` so signer and JwtStrategy cannot diverge. */
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (_config: ConfigService) => ({
        secret: accessTokenSecret(),
        signOptions: { expiresIn: '1d' },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtStrategy,
    OtpService,
    RefreshTokenService,
    EsmsService,
  ],
  // RefreshTokenService is exported so `users` can end a staff member's sessions on deactivate/delete - one revocation seam, not a second copy.
  exports: [AuthService, RefreshTokenService],
})
export class AuthModule {}
