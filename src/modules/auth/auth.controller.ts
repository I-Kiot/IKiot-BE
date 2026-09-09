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
import { SendOtpDto } from './dto/send-otp.dto';
import {
  CheckAvailabilityDto,
  LogoutDto,
  RefreshTokenDto,
  ResetPasswordDto,
  VerifyForgotPasswordOtpDto,
} from './dto/session.dto';
import { FirebaseLoginDto } from './dto/firebase-login.dto';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthUser } from '../../common/types/auth-user.type';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('send-otp')
  sendOtp(@Body() dto: SendOtpDto) {
    return this.authService.sendOtp(dto);
  }

  /** Whether a phone number / shop name is free, for the registration form - public by necessity, since it is asked before an account exists. */
  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('check-availability')
  checkAvailability(@Body() dto: CheckAvailabilityDto) {
    return this.authService.checkAvailability(dto);
  }

  // `user-agent` is recorded against the session, as iKiotMS-BE stored it on the RefreshToken document - it is what makes a device list possible later.
  @Public()
  @Post('register')
  register(
    @Body() dto: RegisterDto,
    @Headers('user-agent') userAgent?: string,
  ) {
    return this.authService.register(dto, userAgent);
  }

  @Public()
  @Post('login')
  login(@Body() dto: LoginDto, @Headers('user-agent') userAgent?: string) {
    return this.authService.login(dto, userAgent);
  }

  @Public()
  @Post('firebase-login')
  firebaseLogin(
    @Body() dto: FirebaseLoginDto,
    @Headers('user-agent') userAgent?: string,
  ) {
    return this.authService.firebaseLogin(dto, userAgent);
  }

  /** Trades a refresh token for a fresh pair. The presented token is revoked. */
  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('refresh')
  refresh(
    @Body() dto: RefreshTokenDto,
    @Headers('user-agent') userAgent?: string,
  ) {
    return this.authService.refresh(dto.refreshToken, userAgent);
  }

  /** Ends this session. Authenticated, so the session ended is provably the caller's. */
  @ApiBearerAuth('bearer')
  @HttpCode(HttpStatus.OK)
  @Post('logout')
  logout(@CurrentUser() user: AuthUser, @Body() dto: LogoutDto) {
    return this.authService.logout(user.userId, dto.refreshToken);
  }

  // ─── Forgot password ───────────────────────────────────────────────────────
  // Three public steps: send a code, trade it for a short-lived reset token, trade that for a new password.

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('send-forgot-password-otp')
  sendForgotPasswordOtp(@Body() dto: SendOtpDto) {
    return this.authService.sendForgotPasswordOtp(dto);
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('verify-forgot-password-otp')
  verifyForgotPasswordOtp(@Body() dto: VerifyForgotPasswordOtpDto) {
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
