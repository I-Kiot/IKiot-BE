import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
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
import { ForgotPasswordDto, ResendOtpDto, VerifyOtpDto } from './dto/otp.dto';
import { CheckAvailabilityDto, ResetPasswordDto } from './dto/session.dto';
import { FirebaseLoginDto } from './dto/firebase-login.dto';
import { OtpPurpose, OtpService } from './otp.service';
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
const RESET_TOKEN_TTL_SECONDS = 15 * 60;

// Challenge OTP: gắn với đúng một tài khoản + mục đích, `jti` bị đốt sau khi đổi mã thành công.
const OTP_CHALLENGE_TOKEN_TYPE = 'otp_challenge';
const CHALLENGE_TTL_SECONDS = 15 * 60;

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

  /** Gửi OTP và đóng gói thành "challenge response": client giữ `challengeToken`, mã nằm trong email. Gửi trước, ký sau, nên gửi lỗi thì không lộ token nào. */
  private async issueChallenge(
    user: { id: string; email: string },
    purpose: OtpPurpose,
    onCooldown: 'reject' | 'rebind',
  ) {
    const jti = randomUUID();
    const delivery = await this.otp.send(purpose, user, jti, onCooldown);
    const challengeToken = this.jwt.sign(
      { sub: user.id, type: OTP_CHALLENGE_TOKEN_TYPE, purpose, jti },
      { expiresIn: CHALLENGE_TTL_SECONDS },
    );
    return { requiresOtp: true as const, challengeToken, ...delivery };
  }

  private invalidChallenge() {
    return new BadRequestException({
      code: ErrorCode.OTP_CHALLENGE_INVALID,
      message: 'The verification session is invalid or has expired',
    });
  }

  /** Đọc challenge token. Mọi lỗi (hỏng, hết hạn, sai loại, sai purpose) cùng một mã `OTP_CHALLENGE_INVALID`. */
  private readChallenge(token: string, expected?: OtpPurpose) {
    let payload: {
      sub?: string;
      type?: string;
      purpose?: string;
      jti?: string;
    };
    try {
      payload = this.jwt.verify(token);
    } catch {
      throw this.invalidChallenge();
    }
    const purpose = Object.values(OtpPurpose).find(
      (p) => p === payload.purpose,
    );
    if (
      payload.type !== OTP_CHALLENGE_TOKEN_TYPE ||
      !payload.sub ||
      !payload.jti ||
      !purpose ||
      (expected && purpose !== expected)
    )
      throw this.invalidChallenge();
    return { userId: payload.sub, purpose, jti: payload.jti };
  }

  /** Mỗi challenge chỉ đổi được một lần, kể cả khi mã là DEV_BYPASS. */
  private async burnChallenge(jti: string): Promise<void> {
    if (!(await this.otp.burn(`challenge:${jti}`, CHALLENGE_TTL_SECONDS)))
      throw this.invalidChallenge();
  }

  /** Tra tài khoản theo số điện thoại hoặc email (có `@` là email). Email bỏ qua tài khoản đã xoá để địa chỉ cũ dùng lại được. */
  private findByIdentifier(identifier: string) {
    return this.prisma.user.findFirst({
      where: identifier.includes('@')
        ? {
            email: identifier.toLowerCase(),
            status: { not: UserStatus.DELETED },
          }
        : { phoneNumber: identifier },
      include: SESSION_USER_INCLUDE,
    });
  }

  private async startSession(
    user: { password?: string | null } & FlatUserProfile &
      Pick<
        AuditableLoginResponse['user'],
        'id' | 'email' | 'phoneNumber' | 'systemRole' | 'tenantId'
      >,
    userAgent?: string,
  ) {
    return {
      accessToken: this.issueAccessToken(user.id),
      refreshToken: await this.refreshTokens.issue(user.id, userAgent),
      user: this.toPublicUser(user),
    } satisfies AuditableLoginResponse;
  }

  private emailMissing() {
    return new ForbiddenException({
      code: ErrorCode.ACCOUNT_EMAIL_MISSING,
      message:
        'This account has no email address. Ask the shop owner to add one.',
    });
  }

  async register(dto: RegisterDto) {
    const [existingPhone, existingEmail, existingTenant] = await Promise.all([
      this.prisma.user.findFirst({ where: { phoneNumber: dto.phoneNumber } }),
      this.prisma.user.findFirst({
        where: { email: dto.email, status: { not: UserStatus.DELETED } },
      }),
      this.prisma.tenant.findFirst({ where: { name: dto.tenantName } }),
    ]);
    if (existingPhone)
      throw new ConflictException({
        code: ErrorCode.PHONE_ALREADY_REGISTERED,
        message: 'Phone number is already registered',
      });
    if (existingEmail)
      throw new ConflictException({
        code: ErrorCode.EMAIL_ALREADY_IN_USE,
        message: 'Email is already in use',
      });
    if (existingTenant)
      throw new ConflictException({
        code: ErrorCode.TENANT_NAME_TAKEN,
        message: 'Tenant name is already taken',
      });

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_COST);

    // Tài khoản được tạo chưa xác minh email: không có token cho tới khi nhập đúng mã (/auth/login/verify-otp).
    // Gửi OTP nằm TRONG transaction: gửi mail lỗi thì shop và chủ shop bị rollback, người dùng sửa cấu hình/email rồi gửi lại form được, thay vì kẹt với số điện thoại, email và tên shop "đã tồn tại".
    const { tenant, owner, challenge } = await this.prisma.$transaction(
      async (tx) => {
        const tenant = await tx.tenant.create({
          data: { name: dto.tenantName },
        });
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
        const challenge = await this.issueChallenge(
          { id: owner.id, email: dto.email },
          OtpPurpose.VERIFY_EMAIL,
          'reject',
        );
        return { tenant, owner, challenge };
      },
      // SMTP có thể mất vài giây; mặc định 5s của Prisma quá ngắn cho một lần gửi mail.
      { timeout: 30_000 },
    );

    return { ...challenge, user: this.toPublicUser(owner), tenant };
  }

  async login(dto: LoginDto, userAgent?: string) {
    const invalid = () =>
      new UnauthorizedException({
        code: ErrorCode.INVALID_CREDENTIALS,
        message: 'Invalid phone number, email or password',
      });
    const identifier = (dto.identifier ?? dto.phoneNumber ?? '').trim();
    if (!identifier) throw invalid();

    const user = await this.findByIdentifier(identifier);
    if (!user || !user.password) throw invalid();
    if (INACTIVE_USER_STATUSES.has(user.status)) throw invalid();
    if (!(await bcrypt.compare(dto.password, user.password))) throw invalid();

    // Chưa xác minh email: mật khẩu đúng vẫn chưa đủ, phải qua OTP (đăng nhập lần đầu của nhân viên, hoặc chủ shop chưa nhập mã lúc đăng ký).
    if (!user.emailVerifiedAt) {
      if (!user.email) throw this.emailMissing();
      return this.issueChallenge(
        { id: user.id, email: user.email },
        OtpPurpose.VERIFY_EMAIL,
        'rebind',
      );
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLogin: new Date() },
    });
    return this.startSession(user, userAgent);
  }

  /** Đổi OTP xác minh email lấy phiên đăng nhập. Đường dẫn chứa `/login` nên AuditInterceptor ghi một dòng LOGIN. */
  async verifyLoginOtp(dto: VerifyOtpDto, userAgent?: string) {
    const challenge = this.readChallenge(
      dto.challengeToken,
      OtpPurpose.VERIFY_EMAIL,
    );
    const user = await this.prisma.user.findUnique({
      where: { id: challenge.userId },
      include: SESSION_USER_INCLUDE,
    });
    if (!user || !user.password || INACTIVE_USER_STATUSES.has(user.status))
      throw new UnauthorizedException({
        code: ErrorCode.ACCOUNT_INACTIVE,
        message: 'Account is not active',
      });

    await this.otp.verify(
      OtpPurpose.VERIFY_EMAIL,
      user.id,
      challenge.jti,
      dto.otpCode,
    );
    await this.burnChallenge(challenge.jti);

    const now = new Date();
    const verified = await this.prisma.user.update({
      where: { id: user.id },
      data: {
        lastLogin: now,
        ...(user.emailVerifiedAt ? {} : { emailVerifiedAt: now }),
      },
      include: SESSION_USER_INCLUDE,
    });
    return this.startSession(verified, userAgent);
  }

  /** Gửi lại mã cho một challenge đang có (cooldown 60s -> 429). Dùng đúng jti cũ nên challenge token đang giữ vẫn dùng tiếp được. */
  async resendOtp(dto: ResendOtpDto) {
    const challenge = this.readChallenge(dto.challengeToken);
    const user = await this.prisma.user.findUnique({
      where: { id: challenge.userId },
      select: { id: true, email: true, status: true, emailVerifiedAt: true },
    });
    if (!user || !user.email || INACTIVE_USER_STATUSES.has(user.status))
      throw this.invalidChallenge();
    if (challenge.purpose === OtpPurpose.VERIFY_EMAIL && user.emailVerifiedAt)
      throw this.invalidChallenge();
    return this.otp.send(
      challenge.purpose,
      { id: user.id, email: user.email },
      challenge.jti,
      'reject',
    );
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

    let emailChanged = false;
    if (dto.email) {
      const emailTaken = await this.prisma.user.findFirst({
        where: {
          email: dto.email,
          id: { not: authUser.userId },
          status: { not: UserStatus.DELETED },
        },
      });
      if (emailTaken)
        throw new ConflictException({
          code: ErrorCode.EMAIL_ALREADY_IN_USE,
          message: 'Email is already in use',
        });
    }

    if (dto.email && canEditFullProfile) {
      const current = await this.prisma.user.findUnique({
        where: { id: authUser.userId },
        select: { email: true },
      });
      emailChanged = current?.email !== dto.email;
    }

    const data = canEditFullProfile
      ? {
          email: dto.email,
          // Đổi địa chỉ thì phải chứng minh lại hộp thư mới.
          ...(emailChanged ? { emailVerifiedAt: null } : {}),
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
    if (dto.newPassword !== dto.reEnterPassword)
      throw new BadRequestException({
        code: ErrorCode.PASSWORD_CONFIRMATION_MISMATCH,
        message: 'The password confirmation does not match',
      });

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
      where: { email, status: { not: UserStatus.DELETED } },
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

    // Google đã chứng minh địa chỉ email này (email_verified đã kiểm tra ở trên).
    const now = new Date();
    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: {
        lastLogin: now,
        ...(user.emailVerifiedAt ? {} : { emailVerifiedAt: now }),
      },
      include: SESSION_USER_INCLUDE,
    });
    return this.startSession(updated, userAgent);
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

  /** Tài khoản được phép qua bước đặt lại mật khẩu. Cùng một thông báo cho "không tồn tại" và "bị khoá", vì endpoint public mà phân biệt được sẽ lộ tài khoản nào đã đăng ký. */
  private async resettableUser(identifier: string) {
    const id = identifier.trim();
    if (!id) {
      throw new BadRequestException({
        code: ErrorCode.PHONE_REQUIRED,
        message: 'Phone number or email is required',
      });
    }
    const user = await this.findByIdentifier(id);
    if (!user || INACTIVE_USER_STATUSES.has(user.status)) {
      throw new BadRequestException({
        code: ErrorCode.PHONE_NOT_REGISTERED,
        message: 'This account is not registered, or it is locked.',
      });
    }
    return user;
  }

  async sendForgotPasswordOtp(dto: ForgotPasswordDto) {
    const user = await this.resettableUser(
      dto.identifier ?? dto.phoneNumber ?? '',
    );
    if (!user.email) throw this.emailMissing();
    const challenge = await this.issueChallenge(
      { id: user.id, email: user.email },
      OtpPurpose.RESET_PASSWORD,
      'rebind',
    );
    return { ...challenge, message: 'Đã gửi mã OTP tới email của bạn.' };
  }

  /** Đổi OTP đã xác minh lấy reset token (`type: 'password_reset'`, có `jti`), được `resetPassword` kiểm tra lại và chỉ dùng một lần. */
  async verifyForgotPasswordOtp(dto: VerifyOtpDto) {
    const challenge = this.readChallenge(
      dto.challengeToken,
      OtpPurpose.RESET_PASSWORD,
    );
    const user = await this.prisma.user.findUnique({
      where: { id: challenge.userId },
      select: {
        id: true,
        phoneNumber: true,
        status: true,
        emailVerifiedAt: true,
      },
    });
    if (!user || INACTIVE_USER_STATUSES.has(user.status))
      throw this.invalidChallenge();

    await this.otp.verify(
      OtpPurpose.RESET_PASSWORD,
      user.id,
      challenge.jti,
      dto.otpCode,
    );
    await this.burnChallenge(challenge.jti);
    // Mã đã chứng minh người nhập đọc được hộp thư này.
    if (!user.emailVerifiedAt)
      await this.prisma.user.update({
        where: { id: user.id },
        data: { emailVerifiedAt: new Date() },
      });

    const resetToken = this.jwt.sign(
      {
        sub: user.id,
        phoneNumber: user.phoneNumber,
        type: PASSWORD_RESET_TOKEN_TYPE,
        jti: randomUUID(),
      },
      { expiresIn: RESET_TOKEN_TTL_SECONDS },
    );
    return { resetToken, message: 'Xác thực mã OTP thành công.' };
  }

  async resetPassword(dto: ResetPasswordDto) {
    let payload: { sub?: string; type?: string; jti?: string };
    try {
      payload = this.jwt.verify<{ sub?: string; type?: string; jti?: string }>(
        dto.token,
      );
    } catch {
      throw new BadRequestException({
        code: ErrorCode.RESET_TOKEN_INVALID,
        message: 'The password reset code is invalid or has expired',
      });
    }
    if (
      payload.type !== PASSWORD_RESET_TOKEN_TYPE ||
      !payload.sub ||
      !payload.jti
    ) {
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

    // Reset token chỉ đổi được mật khẩu một lần.
    if (!(await this.otp.burn(`reset:${payload.jti}`, RESET_TOKEN_TTL_SECONDS)))
      throw new BadRequestException({
        code: ErrorCode.RESET_TOKEN_USED,
        message: 'This password reset code has already been used',
      });

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

  /** Kiểm tra số điện thoại, email hoặc tên shop đã tồn tại chưa. Lộ sự tồn tại là chủ đích, chỉ cho form đăng ký kiểm tra trước khi submit; chỉ truy vấn trường được gửi. */
  async checkAvailability(dto: CheckAvailabilityDto) {
    const [phoneTaken, emailTaken, tenantTaken] = await Promise.all([
      dto.phoneNumber
        ? this.prisma.user.findFirst({
            where: { phoneNumber: dto.phoneNumber },
            select: { id: true },
          })
        : null,
      dto.email
        ? this.prisma.user.findFirst({
            where: { email: dto.email, status: { not: UserStatus.DELETED } },
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
      emailTaken: Boolean(emailTaken),
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
