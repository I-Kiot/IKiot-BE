import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { UpdateMeDto } from './dto/update-me.dto';
import { ForgotPasswordDto, ResendOtpDto, VerifyOtpDto } from './dto/otp.dto';
import {
  CheckAvailabilityDto,
  LogoutDto,
  RefreshTokenDto,
  ResetPasswordDto,
} from './dto/session.dto';
import { FirebaseLoginDto } from './dto/firebase-login.dto';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthUser } from '../../common/types/auth-user.type';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /** Kiểm số điện thoại / tên shop còn trống cho form đăng ký. */
  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('check-availability')
  checkAvailability(@Body() dto: CheckAvailabilityDto) {
    return this.authService.checkAvailability(dto);
  }

  /** Tạo chủ shop chưa xác minh và gửi OTP qua email; chưa có token, nhận phiên ở /auth/login/verify-otp. */
  @Public()
  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Public()
  @Post('login')
  login(@Body() dto: LoginDto, @Headers('user-agent') userAgent?: string) {
    return this.authService.login(dto, userAgent);
  }

  /** Đổi challenge token + mã OTP lấy phiên đăng nhập. Lưu user-agent vào phiên như login. */
  @Public()
  @Post('login/verify-otp')
  verifyLoginOtp(
    @Body() dto: VerifyOtpDto,
    @Headers('user-agent') userAgent?: string,
  ) {
    return this.authService.verifyLoginOtp(dto, userAgent);
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('resend-otp')
  resendOtp(@Body() dto: ResendOtpDto) {
    return this.authService.resendOtp(dto);
  }

  @Public()
  @Post('firebase-login')
  firebaseLogin(
    @Body() dto: FirebaseLoginDto,
    @Headers('user-agent') userAgent?: string,
  ) {
    return this.authService.firebaseLogin(dto, userAgent);
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('refresh')
  refresh(
    @Body() dto: RefreshTokenDto,
    @Headers('user-agent') userAgent?: string,
  ) {
    return this.authService.refresh(dto.refreshToken, userAgent);
  }

  /** Kết thúc phiên hiện tại. Phải đăng nhập nên phiên bị kết thúc chắc chắn là của người gọi. */
  @ApiBearerAuth('bearer')
  @HttpCode(HttpStatus.OK)
  @Post('logout')
  logout(@CurrentUser() user: AuthUser, @Body() dto: LogoutDto) {
    return this.authService.logout(user.userId, dto.refreshToken);
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('send-forgot-password-otp')
  sendForgotPasswordOtp(@Body() dto: ForgotPasswordDto) {
    return this.authService.sendForgotPasswordOtp(dto);
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('verify-forgot-password-otp')
  verifyForgotPasswordOtp(@Body() dto: VerifyOtpDto) {
    return this.authService.verifyForgotPasswordOtp(dto);
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('reset-password')
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }

  @ApiBearerAuth('bearer')
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.authService.me(user);
  }

  @ApiBearerAuth('bearer')
  @Patch('me')
  updateMe(@CurrentUser() user: AuthUser, @Body() dto: UpdateMeDto) {
    return this.authService.updateMe(user, dto);
  }

  @ApiBearerAuth('bearer')
  @Post('change-password')
  changePassword(
    @CurrentUser() user: AuthUser,
    @Body() dto: ChangePasswordDto,
  ) {
    return this.authService.changePassword(user.userId, dto);
  }
}
