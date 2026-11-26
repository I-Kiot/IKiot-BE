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
import { EmailModule } from '../../common/email/email.module';
import { FirebaseModule } from '../../common/firebase/firebase.module';
import { WorkingScheduleModule } from '../working-schedules/working-schedules.module';

@Module({
  imports: [
    PassportModule,
    // Dùng chung với PushService: một Firebase Admin app cho cả process.
    FirebaseModule,
    // OtpService gửi mã qua email.
    EmailModule,
    // JwtStrategy kiểm tra quyền trưởng ca ở mỗi request.
    WorkingScheduleModule,
    /** JwtModule đăng ký async để đọc secret sau khi nạp `.env`. */
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
  providers: [AuthService, JwtStrategy, OtpService, RefreshTokenService],
  // Xuất RefreshTokenService để thu hồi phiên khi khoá/xoá nhân viên.
  exports: [AuthService, RefreshTokenService],
})
export class AuthModule {}
