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
    // Dùng chung với PushService: một Firebase Admin app cho cả process.
    FirebaseModule,
    // JwtStrategy kiểm tra quyền trưởng ca ở mỗi request.
    WorkingScheduleModule,
    /** Dùng registerAsync để factory chạy sau khi ConfigModule đọc .env (register() đồng bộ sẽ ký bằng secret rỗng). Key lấy từ accessTokenSecret() để signer và JwtStrategy không lệch nhau. */
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
  // Export RefreshTokenService để users thu hồi phiên của nhân viên khi khoá/xoá: một điểm thu hồi duy nhất.
  exports: [AuthService, RefreshTokenService],
})
export class AuthModule {}
