import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import type { DecodedIdToken } from 'firebase-admin/auth';
import { PrismaService } from '../../prisma/prisma.service';
import { SystemRole } from '../../common/constants/system-role';
import {
  INACTIVE_USER_STATUSES,
  UserStatus,
} from '../../common/constants/user-status';
import type { AuthUser } from '../../common/types/auth-user.type';
import type { AuditableLoginResponse } from '../../common/types/login-response.type';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { UpdateMeDto } from './dto/update-me.dto';
import { SendOtpDto } from './dto/send-otp.dto';
import {
  CheckAvailabilityDto,
  ResetPasswordDto,
  VerifyForgotPasswordOtpDto,
} from './dto/session.dto';
import { FirebaseLoginDto } from './dto/firebase-login.dto';
import { OtpService } from './otp.service';
import { RefreshTokenService } from './refresh-token.service';
import { FirebaseService } from '../../common/firebase/firebase.service';
import { ErrorCode } from '../../common/errors/error-codes';
import {
  withNestedProfile,
  type FlatUserProfile,
} from '../../common/utils/user-profile';
import { LOCATION_SELECT } from '../../common/dto/location-ref.dto';

const BCRYPT_COST = 10;

// Kèm vào user trả về: chỉ `locationId` không cho biết là chi nhánh hay kho, mà dashboard cần để lọc theo phạm vi. Dạng `{ id, type, name }` theo schema; không thêm lại `branchId`/`warehouseId`.
const SESSION_USER_INCLUDE = {
  location: LOCATION_SELECT,
  // Nhân viên xưởng: dashboard dùng để chuyển sang màn hình xưởng.
  workshop: { select: { id: true, supplierName: true } },
} as const;

// Đánh dấu vào reset token và kiểm tra lại khi dùng, để access token thông thường gửi tới /auth/reset-password không bị coi là quyền đặt lại mật khẩu.
const PASSWORD_RESET_TOKEN_TYPE = 'password_reset';

// Giống AuthService của iKiotMS-BE: "mobile" chỉ dành cho nhân viên, "web" cho mọi tài khoản trừ CUSTOMER.
const ROLE_DENIED_MOBILE = 'This app is for employees and managers only';
const ROLE_DENIED_WEB = 'A customer account cannot sign in here';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly otp: OtpService,
    private readonly firebase: FirebaseService,
    private readonly refreshTokens: RefreshTokenService,
  ) {}

  sendOtp(dto: SendOtpDto) {
    return this.otp.sendOtp(dto.phoneNumber);
  }

  async register(dto: RegisterDto, userAgent?: string) {
    const [existingPhone, existingTenant] = await Promise.all([
      this.prisma.user.findFirst({ where: { phoneNumber: dto.phoneNumber } }),
      this.prisma.tenant.findFirst({ where: { name: dto.tenantName } }),
    ]);
    if (existingPhone)
      throw new ConflictException({
        code: ErrorCode.PHONE_ALREADY_REGISTERED,
        message: 'Phone number is already registered',
      });
    if (existingTenant)
      throw new ConflictException({
        code: ErrorCode.TENANT_NAME_TAKEN,
        message: 'Tenant name is already taken',
      });

    // Phải xác minh OTP trước khi tạo bất kỳ bản ghi nào.
    await this.otp.verifyOtp(dto.phoneNumber, dto.otpCode);

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_COST);

    const { tenant, owner } = await this.prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({ data: { name: dto.tenantName } });
      const owner = await tx.user.create({
        data: {
          tenantId: tenant.id,
          phoneNumber: dto.phoneNumber,
          email: dto.email,
          password: passwordHash,
          systemRole: SystemRole.TENANT_OWNER,
          status: UserStatus.ACTIVE,
          profileFirstName: dto.firstName,
          profileLastName: dto.lastName,
        },
      });
      await tx.tenant.update({
        where: { id: tenant.id },
        data: { tenantOwnerId: owner.id },
      });
      return { tenant, owner };
    });

    return {
      accessToken: this.issueAccessToken(owner.id),
      refreshToken: await this.refreshTokens.issue(owner.id, userAgent),
      user: this.toPublicUser(owner),
      tenant,
    };
  }

  async login(dto: LoginDto, userAgent?: string) {
    const user = await this.prisma.user.findFirst({
      where: { phoneNumber: dto.phoneNumber },
      include: SESSION_USER_INCLUDE,
    });
    if (!user || !user.password)
      throw new UnauthorizedException({
        code: ErrorCode.INVALID_CREDENTIALS,
        message: 'Invalid phone number or password',
      });
    if (INACTIVE_USER_STATUSES.has(user.status))
      throw new UnauthorizedException({
        code: ErrorCode.INVALID_CREDENTIALS,
        message: 'Invalid phone number or password',
      });

    const matches = await bcrypt.compare(dto.password, user.password);
    if (!matches)
      throw new UnauthorizedException({
        code: ErrorCode.INVALID_CREDENTIALS,
        message: 'Invalid phone number or password',
      });

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLogin: new Date() },
    });

    return {
      accessToken: this.issueAccessToken(user.id),
      refreshToken: await this.refreshTokens.issue(user.id, userAgent),
      user: this.toPublicUser(user),
    } satisfies AuditableLoginResponse;
  }

  /** Quyền hiện có của tài khoản đang đăng nhập. Rỗng với ADMIN/TENANT_OWNER (guard bỏ qua); quyền phụ của trưởng ca hết hạn theo thời gian. Chỉ để vẽ UI, không phải nguồn phân quyền. */
  async me(authUser: AuthUser) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: authUser.userId },
      include: {
        role: { select: { id: true, name: true } },
        ...SESSION_USER_INCLUDE,
      },
    });
    return {
      ...this.toPublicUser(user),
      permissions: [...authUser.permissions],
    };
  }

  async updateMe(authUser: AuthUser, dto: UpdateMeDto) {
    const canEditFullProfile =
      authUser.systemRole === SystemRole.TENANT_OWNER ||
      authUser.systemRole === SystemRole.ADMIN;

    if (dto.email) {
      const emailTaken = await this.prisma.user.findFirst({
        where: { email: dto.email, id: { not: authUser.userId } },
      });
      if (emailTaken)
        throw new ConflictException({
          code: ErrorCode.EMAIL_ALREADY_IN_USE,
          message: 'Email is already in use',
        });
    }

    const data = canEditFullProfile
      ? {
          email: dto.email,
          profileFirstName: dto.firstName,
          profileLastName: dto.lastName,
          profileAvatarUrl: dto.avatarUrl,
          profileDob: dto.dob ? new Date(dto.dob) : undefined,
          profileAddress: dto.address,
          profileTaxNumber: dto.taxNumber,
          profileIdentificationId: dto.identificationId,
          profileGender: dto.gender,
        }
      : { profileAvatarUrl: dto.avatarUrl };

    const user = await this.prisma.user.update({
      where: { id: authUser.userId },
      data,
      include: SESSION_USER_INCLUDE,
    });
    return this.toPublicUser(user);
  }

  async changePassword(userId: string, dto: ChangePasswordDto) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    if (!user.password)
      throw new BadRequestException({
        code: ErrorCode.PASSWORD_NOT_SET,
        message: 'This account has no password set',
      });

    const matches = await bcrypt.compare(dto.currentPassword, user.password);
    if (!matches)
      throw new BadRequestException({
        code: ErrorCode.CURRENT_PASSWORD_INCORRECT,
        message: 'Current password is incorrect',
      });

    const passwordHash = await bcrypt.hash(dto.newPassword, BCRYPT_COST);
    await this.prisma.user.update({
      where: { id: userId },
      data: { password: passwordHash },
    });
    // Các phiên khác bị thu hồi; access token đã cấp vẫn dùng được tới khi hết hạn (như hệ thống cũ).
    await this.refreshTokens.revokeAllFor(userId);
    return { success: true };
  }

  /** Đăng nhập bằng Firebase ID token (Google), khớp user theo email, không tự tạo tài khoản. `platform` quyết định cổng vai trò ("mobile" chỉ STAFF). */
  async firebaseLogin(dto: FirebaseLoginDto, userAgent?: string) {
    if (!this.firebase.isConfigured()) {
      throw new UnauthorizedException({
        code: ErrorCode.GOOGLE_SIGNIN_NOT_CONFIGURED,
        message: 'Google sign-in is not configured on this server',
      });
    }

    let decoded: DecodedIdToken;
    try {
      decoded = await this.firebase.verifyIdToken(dto.idToken);
    } catch {
      throw new UnauthorizedException({
        code: ErrorCode.GOOGLE_TOKEN_INVALID,
        message: 'The Google sign-in session is invalid or has expired',
      });
    }

    const email = (decoded.email || '').toLowerCase().trim();
    if (!email)
      throw new UnauthorizedException({
        code: ErrorCode.GOOGLE_EMAIL_MISSING,
        message: 'This Google account has no email address',
      });
    if (decoded.email_verified === false) {
      throw new UnauthorizedException({
        code: ErrorCode.GOOGLE_EMAIL_UNVERIFIED,
        message: 'This Google email address is not verified',
      });
    }

    const user = await this.prisma.user.findFirst({
      where: { email },
      include: SESSION_USER_INCLUDE,
    });
    if (!user)
      throw new UnauthorizedException({
        code: ErrorCode.ACCOUNT_NOT_REGISTERED,
        message: 'This email address is not registered',
      });
    if (INACTIVE_USER_STATUSES.has(user.status)) {
      throw new UnauthorizedException({
        code: ErrorCode.ACCOUNT_INACTIVE,
        message: 'Account is not active',
      });
    }

    if (dto.platform === 'mobile') {
      if (user.systemRole !== SystemRole.STAFF)
        throw new ForbiddenException({
          code: ErrorCode.LOGIN_MOBILE_STAFF_ONLY,
          message: ROLE_DENIED_MOBILE,
        });
    } else if (user.systemRole === SystemRole.CUSTOMER) {
      throw new ForbiddenException({
        code: ErrorCode.LOGIN_WEB_CUSTOMER_DENIED,
        message: ROLE_DENIED_WEB,
      });
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLogin: new Date() },
    });
    return {
      accessToken: this.issueAccessToken(user.id),
      refreshToken: await this.refreshTokens.issue(user.id, userAgent),
      user: this.toPublicUser(user),
    } satisfies AuditableLoginResponse;
  }

  async refresh(refreshToken: string, userAgent?: string) {
    const rotated = await this.refreshTokens.rotate(refreshToken, userAgent);

    // Đọc lại user để chắc tài khoản còn dùng được: token cấp trước khi bị khoá không được sống sót qua đó, vì JwtStrategy chỉ kiểm tra access token.
    const user = await this.prisma.user.findUnique({
      where: { id: rotated.userId },
      select: { id: true, status: true },
    });
    if (!user || INACTIVE_USER_STATUSES.has(user.status)) {
      await this.refreshTokens.revokeAllFor(rotated.userId);
      throw new UnauthorizedException({
        code: ErrorCode.ACCOUNT_INACTIVE,
        message: 'Account is not active',
      });
    }

    return {
      accessToken: this.issueAccessToken(user.id),
      refreshToken: rotated.refreshToken,
    };
  }

  async logout(userId: string, refreshToken?: string) {
    if (refreshToken) await this.refreshTokens.revoke(userId, refreshToken);
    return { success: true };
  }

  /** Tài khoản được phép qua bước đặt lại mật khẩu. Cùng một thông báo cho "không tồn tại" và "bị khoá", vì endpoint public mà phân biệt được sẽ lộ số điện thoại nào đã đăng ký. */
  private async resettableUser(phoneNumber: string) {
    const phone = phoneNumber.trim();
    if (!phone) {
      throw new BadRequestException({
        code: ErrorCode.PHONE_REQUIRED,
        message: 'Phone number is required',
      });
    }
    const user = await this.prisma.user.findFirst({
      where: { phoneNumber: phone },
      select: { id: true, phoneNumber: true, status: true },
    });
    if (!user || INACTIVE_USER_STATUSES.has(user.status)) {
      throw new BadRequestException({
        code: ErrorCode.PHONE_NOT_REGISTERED,
        message:
          'This phone number is not registered, or the account is locked.',
      });
    }
    return user;
  }

  async sendForgotPasswordOtp(dto: SendOtpDto) {
    await this.resettableUser(dto.phoneNumber);
    await this.otp.sendOtp(dto.phoneNumber);
    return {
      message: 'Đã gửi mã OTP thành công đến số điện thoại của bạn.',
    };
  }

  /** Đổi OTP đã xác minh lấy reset token có `type: 'password_reset'`, được `resetPassword` kiểm tra lại. */
  async verifyForgotPasswordOtp(dto: VerifyForgotPasswordOtpDto) {
    const user = await this.resettableUser(dto.phoneNumber);
    await this.otp.verifyOtp(dto.phoneNumber, dto.otpCode);

    const resetToken = this.jwt.sign(
      {
        sub: user.id,
        phoneNumber: user.phoneNumber,
        type: PASSWORD_RESET_TOKEN_TYPE,
      },
      { expiresIn: '15m' },
    );
    return { resetToken, message: 'Xác thực mã OTP thành công.' };
  }

  async resetPassword(dto: ResetPasswordDto) {
    let payload: { sub?: string; type?: string };
    try {
      payload = this.jwt.verify<{ sub?: string; type?: string }>(dto.token);
    } catch {
      throw new BadRequestException({
        code: ErrorCode.RESET_TOKEN_INVALID,
        message: 'The password reset code is invalid or has expired',
      });
    }
    if (payload.type !== PASSWORD_RESET_TOKEN_TYPE || !payload.sub) {
      throw new BadRequestException({
        code: ErrorCode.RESET_TOKEN_WRONG_TYPE,
        message: 'This token is not valid for resetting a password',
      });
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, status: true },
    });
    if (!user || INACTIVE_USER_STATUSES.has(user.status)) {
      throw new BadRequestException({
        code: ErrorCode.ACCOUNT_NOT_FOUND_OR_LOCKED,
        message: 'Account does not exist or is locked',
      });
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { password: await bcrypt.hash(dto.newPassword, BCRYPT_COST) },
    });
    // Đặt lại mật khẩu thường do lộ mật khẩu, nên thu hồi mọi phiên có thể đã dùng mật khẩu cũ.
    await this.refreshTokens.revokeAllFor(user.id);

    return {
      message: 'Đặt lại mật khẩu thành công. Vui lòng đăng nhập lại.',
    };
  }

  /** Kiểm tra số điện thoại hoặc tên shop đã tồn tại chưa. Lộ sự tồn tại là chủ đích, chỉ cho hai trường form đăng ký cần kiểm tra trước khi submit. */
  async checkAvailability(dto: CheckAvailabilityDto) {
    const [phoneTaken, tenantTaken] = await Promise.all([
      dto.phoneNumber
        ? this.prisma.user.findFirst({
            where: { phoneNumber: dto.phoneNumber },
            select: { id: true },
          })
        : null,
      dto.tenantName
        ? this.prisma.tenant.findFirst({
            where: { name: dto.tenantName },
            select: { id: true },
          })
        : null,
    ]);

    return {
      phoneNumberTaken: Boolean(phoneTaken),
      tenantNameTaken: Boolean(tenantTaken),
    };
  }

  private issueAccessToken(userId: string): string {
    return this.jwt.sign({ sub: userId });
  }

  /** Bỏ password hash và gom cột `profile_*` thành object `profile` như `/users`, để dashboard đọc `user.profile.firstName` ở cả `/auth/me` và `/auth/login`. */
  private toPublicUser<
    T extends { password?: string | null } & FlatUserProfile,
  >(user: T) {
    const { password, ...rest } = user;
    return withNestedProfile(rest);
  }
}
