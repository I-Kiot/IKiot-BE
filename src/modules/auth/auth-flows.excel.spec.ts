import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { AuthService } from './auth.service';
import { maskEmail, OtpPurpose, OtpService } from './otp.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { RefreshTokenService } from './refresh-token.service';

const bodyOf = (error: unknown) =>
  (error as BadRequestException).getResponse() as {
    code: string;
    message: string;
  };

/** Kiểm `run` bị reject với lỗi `type` mang `code` (và `message` nếu có). */
async function expectRejects(
  run: Promise<unknown>,
  type: new (...args: never[]) => Error,
  code: string,
  message?: string,
) {
  let caught: unknown;
  try {
    await run;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(type);
  expect(bodyOf(caught).code).toBe(code);
  if (message) expect(bodyOf(caught).message).toBe(message);
}

/** Bản giả RedisService trong bộ nhớ. */
function fakeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    available: true,
    get: jest.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    set: jest.fn(function (this: any, key: string, value: string) {
      store.set(key, value);
      return Promise.resolve(true);
    }),
    setIfAbsent: jest.fn((key: string, value: string) => {
      if (store.has(key)) return Promise.resolve(false);
      store.set(key, value);
      return Promise.resolve(true);
    }),
    del: jest.fn((...keys: string[]) => {
      keys.forEach((k) => store.delete(k));
      return Promise.resolve();
    }),
    keysMatching: jest.fn((pattern: string) => {
      const prefix = pattern.replace('*', '');
      return Promise.resolve(
        [...store.keys()].filter((k) => k.startsWith(prefix)),
      );
    }),
  };
}

const SECRET = 'test-secret';
const ENV_KEYS = ['ACCESS_TOKEN_SECRET', 'REFRESH_TOKEN_SECRET', 'JWT_SECRET'];
const savedEnv: Record<string, string | undefined> = {};
beforeAll(() => {
  ENV_KEYS.forEach((k) => (savedEnv[k] = process.env[k]));
  delete process.env.REFRESH_TOKEN_SECRET;
  delete process.env.JWT_SECRET;
  process.env.ACCESS_TOKEN_SECRET = SECRET;
});
afterAll(() => {
  ENV_KEYS.forEach((k) => {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  });
});

describe('AuthService flows', () => {
  let prisma: any;
  let tx: any;
  let redis: ReturnType<typeof fakeRedis>;
  let email: { isConfigured: jest.Mock; sendOtpEmail: jest.Mock };
  let otp: OtpService;
  let jwt: JwtService;
  let refreshTokens: {
    issue: jest.Mock;
    revokeAllFor: jest.Mock;
    rotate: jest.Mock;
    revoke: jest.Mock;
  };
  let firebase: { isConfigured: jest.Mock; verifyIdToken: jest.Mock };
  let service: AuthService;

  beforeEach(() => {
    redis = fakeRedis();
    email = {
      isConfigured: jest.fn().mockReturnValue(true),
      sendOtpEmail: jest.fn().mockResolvedValue(undefined),
    };
    otp = new OtpService(email as never, redis as never);
    jwt = new JwtService({ secret: SECRET });
    tx = {
      tenant: {
        create: jest.fn().mockResolvedValue({ id: 'T9', name: 'Cua hang A' }),
        update: jest.fn().mockResolvedValue({}),
      },
      user: {
        create: jest
          .fn()
          .mockImplementation(({ data }) =>
            Promise.resolve({ id: 'U9', ...data }),
          ),
      },
    };
    prisma = {
      user: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
      tenant: { findFirst: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn().mockImplementation((fn) => fn(tx)),
    };
    refreshTokens = {
      issue: jest.fn().mockResolvedValue('refresh-token'),
      revokeAllFor: jest.fn().mockResolvedValue(undefined),
      rotate: jest.fn(),
      revoke: jest.fn().mockResolvedValue(undefined),
    };
    firebase = {
      isConfigured: jest.fn().mockReturnValue(true),
      verifyIdToken: jest.fn(),
    };
    service = new AuthService(
      prisma,
      jwt,
      otp,
      firebase as never,
      refreshTokens as never,
    );
  });

  /** Mã OTP trong email gần nhất (mã không bao giờ lưu dạng rõ, nên test đọc từ lời gọi gửi mail). */
  const emailed = () => {
    const calls = email.sendOtpEmail.mock.calls;
    return calls[calls.length - 1][1] as string;
  };

  const passwordHash = bcrypt.hashSync('Abc@12345', 4);
  /** Một dòng user đã xác minh email; `over` ghi đè từng trường. */
  const userRow = (over: Record<string, unknown> = {}) => ({
    id: 'U1',
    tenantId: 'T1',
    phoneNumber: '0912345678',
    email: 'anna@mail.com',
    password: passwordHash,
    status: 'ACTIVE',
    systemRole: 'TENANT_OWNER',
    emailVerifiedAt: new Date('2026-01-01'),
    profileFirstName: 'A',
    profileLastName: 'N',
    ...over,
  });
  const unverified = (over: Record<string, unknown> = {}) =>
    userRow({ emailVerifiedAt: null, ...over });

  /** findFirst trả theo trường tra cứu: số điện thoại hoặc email. */
  const findFirstBy = (rows: { phone?: unknown; email?: unknown }) =>
    prisma.user.findFirst.mockImplementation(
      ({ where }: { where: { phoneNumber?: string; email?: string } }) =>
        Promise.resolve(
          (where.phoneNumber ? rows.phone : where.email ? rows.email : null) ??
            null,
        ),
    );

  // ── Auth: register (UTC008-UTC013) ──
  describe('Excel sheet Auth - register', () => {
    const dto = (over: Record<string, unknown> = {}) => ({
      phoneNumber: '0987000010',
      tenantName: 'Cua hang A',
      password: 'Abc@12345',
      email: 'anna@mail.com',
      firstName: 'A',
      lastName: 'Nguyen',
      ...over,
    });

    it('UTC008: creates the tenant and an unverified owner in one transaction, mails an OTP and issues no token', async () => {
      const res = await service.register(dto());
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      const data = tx.user.create.mock.calls[0][0].data;
      expect(data).toEqual(
        expect.objectContaining({
          tenantId: 'T9',
          phoneNumber: '0987000010',
          email: 'anna@mail.com',
          systemRole: 'TENANT_OWNER',
          status: 'ACTIVE',
        }),
      );
      expect(data).not.toHaveProperty('emailVerifiedAt');
      expect(await bcrypt.compare('Abc@12345', data.password)).toBe(true);
      expect(tx.tenant.update).toHaveBeenCalledWith({
        where: { id: 'T9' },
        data: { tenantOwnerId: 'U9' },
      });
      expect(res).not.toHaveProperty('accessToken');
      expect(res).not.toHaveProperty('refreshToken');
      expect(refreshTokens.issue).not.toHaveBeenCalled();
      expect(res).toEqual(
        expect.objectContaining({
          requiresOtp: true,
          sentTo: 'an***@mail.com',
          expiresInSeconds: 300,
          resendAfterSeconds: 60,
        }),
      );
      expect(res.tenant.id).toBe('T9');
      expect(res.user).not.toHaveProperty('password');
      expect(email.sendOtpEmail).toHaveBeenCalledWith(
        'anna@mail.com',
        expect.stringMatching(/^\d{6}$/),
        { purpose: 'verify-email', ttlMinutes: 5 },
      );
      const claims = jwt.verify<Record<string, string>>(res.challengeToken);
      expect(claims).toEqual(
        expect.objectContaining({
          sub: 'U9',
          type: 'otp_challenge',
          purpose: 'verify-email',
          jti: expect.any(String),
        }),
      );
    });

    it('UTC009: a phone number that is already registered', async () => {
      findFirstBy({ phone: { id: 'U1' } });
      await expectRejects(
        service.register(dto()),
        ConflictException,
        'PHONE_ALREADY_REGISTERED',
        'Phone number is already registered',
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('UTC010: a tenant name that is already taken', async () => {
      prisma.tenant.findFirst.mockResolvedValue({ id: 'T1' });
      await expectRejects(
        service.register(dto()),
        ConflictException,
        'TENANT_NAME_TAKEN',
        'Tenant name is already taken',
      );
    });

    it('UTC011: an email that is already in use (deleted accounts do not count)', async () => {
      findFirstBy({ email: { id: 'U1' } });
      prisma.tenant.findFirst.mockResolvedValue({ id: 'T1' });
      await expectRejects(
        service.register(dto()),
        ConflictException,
        'EMAIL_ALREADY_IN_USE',
        'Email is already in use',
      );
      expect(prisma.user.findFirst).toHaveBeenCalledWith({
        where: { email: 'anna@mail.com', status: { not: 'DELETED' } },
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('UTC012: when the email cannot be sent the sign-up answers 503, the shop and owner are rolled back and no code stays stored', async () => {
      email.sendOtpEmail.mockRejectedValue(new Error('smtp down'));
      await expectRejects(
        service.register(dto()),
        ServiceUnavailableException,
        'OTP_SEND_FAILED',
      );
      expect(redis.store.size).toBe(0);
      // Gửi mail lỗi thì rollback tenant và chủ shop.
      expect(email.sendOtpEmail).toHaveBeenCalledTimes(1);
      await expect(prisma.$transaction.mock.results[0].value).rejects.toThrow(
        ServiceUnavailableException,
      );
      expect(prisma.$transaction.mock.calls[0][1]).toEqual({ timeout: 30_000 });
    });

    it('UTC013: phone and tenant name both taken reports the phone first', async () => {
      findFirstBy({ phone: { id: 'U1' }, email: { id: 'U2' } });
      prisma.tenant.findFirst.mockResolvedValue({ id: 'T1' });
      await expectRejects(
        service.register(dto()),
        ConflictException,
        'PHONE_ALREADY_REGISTERED',
      );
    });
  });

  // ── Auth: checkAvailability (UTC014-UTC017) ──
  describe('Excel sheet Auth - checkAvailability', () => {
    it('UTC014: all three taken', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 'U1' });
      prisma.tenant.findFirst.mockResolvedValue({ id: 'T1' });
      await expect(
        service.checkAvailability({
          phoneNumber: '0987000010',
          email: 'anna@mail.com',
          tenantName: 'Cua hang A',
        }),
      ).resolves.toEqual({
        phoneNumberTaken: true,
        emailTaken: true,
        tenantNameTaken: true,
      });
    });
    it('UTC015: all free', async () => {
      await expect(
        service.checkAvailability({
          phoneNumber: '0987999999',
          email: 'new@mail.com',
          tenantName: 'Cua hang Z',
        }),
      ).resolves.toEqual({
        phoneNumberTaken: false,
        emailTaken: false,
        tenantNameTaken: false,
      });
    });
    it('UTC016: only the phone is checked when nothing else is sent', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 'U1' });
      await expect(
        service.checkAvailability({ phoneNumber: '0987000010' }),
      ).resolves.toEqual({
        phoneNumberTaken: true,
        emailTaken: false,
        tenantNameTaken: false,
      });
      expect(prisma.user.findFirst).toHaveBeenCalledTimes(1);
      expect(prisma.tenant.findFirst).not.toHaveBeenCalled();
    });
    it('UTC017: nothing sent means no query, and the email check ignores deleted accounts', async () => {
      await expect(service.checkAvailability({})).resolves.toEqual({
        phoneNumberTaken: false,
        emailTaken: false,
        tenantNameTaken: false,
      });
      expect(prisma.user.findFirst).not.toHaveBeenCalled();
      expect(prisma.tenant.findFirst).not.toHaveBeenCalled();
      await service.checkAvailability({ email: 'x@mail.com' });
      expect(prisma.user.findFirst).toHaveBeenCalledWith({
        where: { email: 'x@mail.com', status: { not: 'DELETED' } },
        select: { id: true },
      });
    });
  });

  // ── OtpService.verify (UTC018-UTC022) ──
  describe('Excel sheet Auth - verifyOtp', () => {
    const send = () =>
      otp.send(
        OtpPurpose.VERIFY_EMAIL,
        { id: 'U1', email: 'a@mail.com' },
        'c1',
      );
    it('UTC018: the correct OTP is accepted and deleted', async () => {
      await send();
      await expect(
        otp.verify(OtpPurpose.VERIFY_EMAIL, 'U1', 'c1', emailed()),
      ).resolves.toBe(true);
      expect(redis.store.size).toBe(0);
    });
    it('UTC019: a wrong OTP is refused and reports the attempts left', async () => {
      await send();
      let caught: unknown;
      try {
        await otp.verify(OtpPurpose.VERIFY_EMAIL, 'U1', 'c1', '000000');
      } catch (e) {
        caught = e;
      }
      // Phòng hờ 1/1.000.000 mã ngẫu nhiên trùng "000000".
      if (emailed() !== '000000') {
        expect(caught).toBeInstanceOf(BadRequestException);
        expect(bodyOf(caught)).toEqual(
          expect.objectContaining({
            code: 'OTP_INVALID',
            message: 'Invalid OTP code',
            attemptsLeft: 4,
          }),
        );
      }
    });
    it('UTC020: no stored OTP means it expired or was never requested', async () => {
      await expectRejects(
        otp.verify(OtpPurpose.VERIFY_EMAIL, 'U1', 'c1', '123456'),
        BadRequestException,
        'OTP_EXPIRED',
        'OTP has expired or was not requested. Please request a new code.',
      );
    });
    it('UTC021: an OTP can be used only once', async () => {
      await send();
      const code = emailed();
      await otp.verify(OtpPurpose.VERIFY_EMAIL, 'U1', 'c1', code);
      await expectRejects(
        otp.verify(OtpPurpose.VERIFY_EMAIL, 'U1', 'c1', code),
        BadRequestException,
        'OTP_EXPIRED',
      );
    });
    it('UTC022: an OTP for one purpose does not verify another purpose', async () => {
      await send();
      await expectRejects(
        otp.verify(OtpPurpose.RESET_PASSWORD, 'U1', 'c1', emailed()),
        BadRequestException,
        'OTP_EXPIRED',
      );
    });
  });

  // ── PasswordRecovery: sendForgotPasswordOtp (UTC023-UTC026) ──
  describe('Excel sheet Auth - sendForgotPasswordOtp', () => {
    it('UTC023: an active account gets an OTP by email and a challenge', async () => {
      prisma.user.findFirst.mockResolvedValue(userRow());
      const res = await service.sendForgotPasswordOtp({
        identifier: '0912345678',
      });
      expect(res).toEqual(
        expect.objectContaining({
          requiresOtp: true,
          challengeToken: expect.any(String),
          sentTo: 'an***@mail.com',
          message: 'Đã gửi mã OTP tới email của bạn.',
        }),
      );
      expect(email.sendOtpEmail).toHaveBeenCalledWith(
        'anna@mail.com',
        expect.any(String),
        { purpose: 'reset-password', ttlMinutes: 5 },
      );
      expect(jwt.verify<{ purpose: string }>(res.challengeToken).purpose).toBe(
        'reset-password',
      );
    });
    it('UTC024: a blank identifier is refused without a lookup', async () => {
      await expectRejects(
        service.sendForgotPasswordOtp({ identifier: '   ' }),
        BadRequestException,
        'PHONE_REQUIRED',
        'Phone number or email is required',
      );
      expect(prisma.user.findFirst).not.toHaveBeenCalled();
    });
    it('UTC025: an unknown account', async () => {
      await expectRejects(
        service.sendForgotPasswordOtp({ identifier: '0900000000' }),
        BadRequestException,
        'PHONE_NOT_REGISTERED',
        'This account is not registered, or it is locked.',
      );
      expect(email.sendOtpEmail).not.toHaveBeenCalled();
    });
    it('UTC026: a locked account gets the same answer as an unknown one', async () => {
      prisma.user.findFirst.mockResolvedValue(userRow({ status: 'SUSPENDED' }));
      await expectRejects(
        service.sendForgotPasswordOtp({ phoneNumber: '0912345678' }),
        BadRequestException,
        'PHONE_NOT_REGISTERED',
        'This account is not registered, or it is locked.',
      );
      expect(email.sendOtpEmail).not.toHaveBeenCalled();
    });
  });

  // ── PasswordRecovery: verifyForgotPasswordOtp (UTC027-UTC029) ──
  describe('Excel sheet Auth - verifyForgotPasswordOtp', () => {
    const start = async () => {
      prisma.user.findFirst.mockResolvedValue(userRow());
      const res = await service.sendForgotPasswordOtp({
        identifier: 'anna@mail.com',
      });
      prisma.user.findUnique.mockResolvedValue(userRow());
      return res.challengeToken;
    };
    it('UTC027: a correct OTP returns a 15-minute single-use password_reset token', async () => {
      const challengeToken = await start();
      const res = await service.verifyForgotPasswordOtp({
        challengeToken,
        otpCode: emailed(),
      });
      expect(res.message).toBe('Xác thực mã OTP thành công.');
      const payload = jwt.verify<{
        sub: string;
        type: string;
        jti: string;
        iat: number;
        exp: number;
      }>(res.resetToken);
      expect(payload.sub).toBe('U1');
      expect(payload.type).toBe('password_reset');
      expect(payload.jti).toEqual(expect.any(String));
      expect(payload.exp - payload.iat).toBe(15 * 60);
    });
    it('UTC028: a wrong OTP is refused', async () => {
      const challengeToken = await start();
      const wrong = emailed() === '000000' ? '111111' : '000000';
      await expectRejects(
        service.verifyForgotPasswordOtp({
          challengeToken,
          otpCode: wrong,
        }),
        BadRequestException,
        'OTP_INVALID',
      );
    });
    it('UTC029: a challenge whose account no longer exists', async () => {
      const challengeToken = await start();
      prisma.user.findUnique.mockResolvedValue(null);
      await expectRejects(
        service.verifyForgotPasswordOtp({
          challengeToken,
          otpCode: emailed(),
        }),
        BadRequestException,
        'OTP_CHALLENGE_INVALID',
      );
    });
  });

  // ── PasswordRecovery: resetPassword (UTC030-UTC034) ──
  describe('Excel sheet Auth - resetPassword', () => {
    const resetToken = (jti: string | undefined = 'r1') =>
      jwt.sign(
        { sub: 'U1', type: 'password_reset', ...(jti ? { jti } : {}) },
        { expiresIn: '15m' },
      );
    it('UTC030: a valid token sets the new password and ends every session', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'U1', status: 'ACTIVE' });
      const res = await service.resetPassword({
        token: resetToken(),
        newPassword: 'Abc@12345',
      });
      expect(res).toEqual({
        message: 'Đặt lại mật khẩu thành công. Vui lòng đăng nhập lại.',
      });
      const data = prisma.user.update.mock.calls[0][0].data;
      expect(await bcrypt.compare('Abc@12345', data.password)).toBe(true);
      expect(refreshTokens.revokeAllFor).toHaveBeenCalledWith('U1');
    });
    it('UTC031: a malformed token', async () => {
      await expectRejects(
        service.resetPassword({
          token: 'abc',
          newPassword: 'Abc@12345',
        }),
        BadRequestException,
        'RESET_TOKEN_INVALID',
        'The password reset code is invalid or has expired',
      );
    });
    it('UTC032: an access token is not a reset token', async () => {
      await expectRejects(
        service.resetPassword({
          token: jwt.sign({ sub: 'U1' }),
          newPassword: 'Abc@12345',
        }),
        BadRequestException,
        'RESET_TOKEN_WRONG_TYPE',
        'This token is not valid for resetting a password',
      );
    });
    it('UTC033: a locked account cannot reset its password', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'U1',
        status: 'INACTIVE',
      });
      await expectRejects(
        service.resetPassword({
          token: resetToken(),
          newPassword: 'Abc@12345',
        }),
        BadRequestException,
        'ACCOUNT_NOT_FOUND_OR_LOCKED',
        'Account does not exist or is locked',
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
    it('UTC034: a deleted user row', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expectRejects(
        service.resetPassword({
          token: resetToken(),
          newPassword: 'Abc@12345',
        }),
        BadRequestException,
        'ACCOUNT_NOT_FOUND_OR_LOCKED',
      );
      expect(refreshTokens.revokeAllFor).not.toHaveBeenCalled();
    });
  });

  // ── PasswordRecovery: changePassword (UTC035-UTC037) ──
  describe('Excel sheet Auth - changePassword', () => {
    it('UTC035: the right current password changes the hash and ends other sessions', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue({
        id: 'U1',
        password: await bcrypt.hash('Abc@12345', 4),
      });
      await expect(
        service.changePassword('U1', {
          currentPassword: 'Abc@12345',
          newPassword: 'Xyz@12345',
        } as never),
      ).resolves.toEqual({ success: true });
      const data = prisma.user.update.mock.calls[0][0].data;
      expect(await bcrypt.compare('Xyz@12345', data.password)).toBe(true);
      expect(refreshTokens.revokeAllFor).toHaveBeenCalledWith('U1');
    });
    it('UTC036: an account without a password', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue({
        id: 'U1',
        password: null,
      });
      await expectRejects(
        service.changePassword('U1', {
          currentPassword: 'x',
          newPassword: 'Xyz@12345',
        } as never),
        BadRequestException,
        'PASSWORD_NOT_SET',
        'This account has no password set',
      );
    });
    it('UTC037: a wrong current password changes nothing', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue({
        id: 'U1',
        password: await bcrypt.hash('Abc@12345', 4),
      });
      await expectRejects(
        service.changePassword('U1', {
          currentPassword: 'Wrong999',
          newPassword: 'Xyz@12345',
        } as never),
        BadRequestException,
        'CURRENT_PASSWORD_INCORRECT',
        'Current password is incorrect',
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(refreshTokens.revokeAllFor).not.toHaveBeenCalled();
    });
  });

  // ── RefreshTokens: AuthService.refresh / logout (UTC051-UTC055) ──
  describe('Excel sheet Auth - AuthService', () => {
    beforeEach(() => {
      refreshTokens.rotate.mockResolvedValue({
        userId: 'U1',
        refreshToken: 'new-refresh',
      });
    });
    it('UTC051: an active user gets a new token pair', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'U1', status: 'ACTIVE' });
      const res = await service.refresh('old-refresh', 'Chrome');
      expect(refreshTokens.rotate).toHaveBeenCalledWith(
        'old-refresh',
        'Chrome',
      );
      expect(res.refreshToken).toBe('new-refresh');
      expect(jwt.verify<{ sub: string }>(res.accessToken).sub).toBe('U1');
    });
    it('UTC052: a user suspended after the token was issued loses every session', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'U1',
        status: 'SUSPENDED',
      });
      await expectRejects(
        service.refresh('old-refresh'),
        UnauthorizedException,
        'ACCOUNT_INACTIVE',
        'Account is not active',
      );
      expect(refreshTokens.revokeAllFor).toHaveBeenCalledWith('U1');
    });
    it('UTC053: a user who no longer exists loses every session', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expectRejects(
        service.refresh('old-refresh'),
        UnauthorizedException,
        'ACCOUNT_INACTIVE',
      );
      expect(refreshTokens.revokeAllFor).toHaveBeenCalledWith('U1');
    });
    it('UTC054: logout with a refresh token revokes that session', async () => {
      await expect(service.logout('U1', 'some-refresh')).resolves.toEqual({
        success: true,
      });
      expect(refreshTokens.revoke).toHaveBeenCalledWith('U1', 'some-refresh');
    });
    it('UTC055: logout without a refresh token revokes nothing', async () => {
      await expect(service.logout('U1', undefined)).resolves.toEqual({
        success: true,
      });
      expect(refreshTokens.revoke).not.toHaveBeenCalled();
    });
  });
  // ── OTP email: guard và các luồng (UTC056+) ──
  describe('Email OTP - guard rules', () => {
    const u = { id: 'U1', email: 'anna@mail.com' };
    const send = (challengeId = 'c1', mode: 'reject' | 'rebind' = 'reject') =>
      otp.send(OtpPurpose.VERIFY_EMAIL, u, challengeId, mode);
    const storedEntry = () =>
      JSON.parse(redis.store.get('otp:verify-email:U1')!) as {
        hash: string;
        challengeId: string;
        attempts: number;
        expiresAt: number;
        sentAt: number;
      };
    const wrongCode = () => (emailed() === '000000' ? '111111' : '000000');
    let nowSpy: jest.SpyInstance | undefined;
    afterEach(() => nowSpy?.mockRestore());

    it('UTC056: a code that the store still returns after its expiry is refused and deleted', async () => {
      await send();
      const code = emailed();
      const entry = storedEntry();
      redis.store.set(
        'otp:verify-email:U1',
        JSON.stringify({ ...entry, expiresAt: Date.now() - 1 }),
      );
      await expectRejects(
        otp.verify(OtpPurpose.VERIFY_EMAIL, 'U1', 'c1', code),
        BadRequestException,
        'OTP_EXPIRED',
      );
      expect(redis.store.has('otp:verify-email:U1')).toBe(false);
    });

    it('UTC057: five wrong codes burn the OTP, even the right code is refused afterwards', async () => {
      await send();
      const code = emailed();
      for (let i = 1; i <= 4; i++) {
        await expectRejects(
          otp.verify(OtpPurpose.VERIFY_EMAIL, 'U1', 'c1', wrongCode()),
          BadRequestException,
          'OTP_INVALID',
        );
        expect(storedEntry().attempts).toBe(i);
      }
      await expectRejects(
        otp.verify(OtpPurpose.VERIFY_EMAIL, 'U1', 'c1', wrongCode()),
        BadRequestException,
        'OTP_TOO_MANY_ATTEMPTS',
      );
      await expectRejects(
        otp.verify(OtpPurpose.VERIFY_EMAIL, 'U1', 'c1', code),
        BadRequestException,
        'OTP_EXPIRED',
      );
    });

    it('UTC058: a code is bound to its challenge', async () => {
      await send('c1');
      await expectRejects(
        otp.verify(OtpPurpose.VERIFY_EMAIL, 'U1', 'other', emailed()),
        BadRequestException,
        'OTP_EXPIRED',
      );
    });

    it('UTC059: a second send inside the cooldown answers 429 with retryAfterSeconds and sends nothing', async () => {
      await send();
      let caught: unknown;
      try {
        await send();
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(HttpException);
      expect((caught as HttpException).getStatus()).toBe(429);
      expect((caught as HttpException).getResponse()).toEqual(
        expect.objectContaining({
          code: 'OTP_RESEND_TOO_SOON',
          retryAfterSeconds: expect.any(Number),
        }),
      );
      expect(email.sendOtpEmail).toHaveBeenCalledTimes(1);
    });

    it('UTC060: rebind inside the cooldown sends no mail, moves the code to the new challenge and drops the old one', async () => {
      await send('c1');
      const code = emailed();
      const delivery = await send('c2', 'rebind');
      expect(delivery.sentTo).toBe('an***@mail.com');
      expect(email.sendOtpEmail).toHaveBeenCalledTimes(1);
      await expectRejects(
        otp.verify(OtpPurpose.VERIFY_EMAIL, 'U1', 'c1', code),
        BadRequestException,
        'OTP_EXPIRED',
      );
      await expect(
        otp.verify(OtpPurpose.VERIFY_EMAIL, 'U1', 'c2', code),
      ).resolves.toBe(true);
    });

    it('UTC061: resending after the cooldown mails a new code and the old one stops working', async () => {
      await send();
      const first = emailed();
      const t0 = Date.now();
      nowSpy = jest.spyOn(Date, 'now').mockReturnValue(t0 + 61_000);
      await send();
      expect(email.sendOtpEmail).toHaveBeenCalledTimes(2);
      const second = emailed();
      if (second !== first) {
        await expectRejects(
          otp.verify(OtpPurpose.VERIFY_EMAIL, 'U1', 'c1', first),
          BadRequestException,
          'OTP_INVALID',
        );
      }
      await expect(
        otp.verify(OtpPurpose.VERIFY_EMAIL, 'U1', 'c1', second),
      ).resolves.toBe(true);
    });

    it('UTC062: only a salted hash of the code is stored', async () => {
      await send();
      const raw = redis.store.get('otp:verify-email:U1')!;
      expect(raw).not.toContain(`"${emailed()}"`);
      expect(storedEntry().hash).toMatch(/^[0-9a-f]{64}$/);
      expect(storedEntry()).not.toHaveProperty('code');
    });

    it('UTC063: the in-memory fallback works when Redis is down', async () => {
      redis.set.mockResolvedValue(false);
      redis.get.mockResolvedValue(null);
      await send();
      await expect(
        otp.verify(OtpPurpose.VERIFY_EMAIL, 'U1', 'c1', emailed()),
      ).resolves.toBe(true);
    });

    it('UTC064: maskEmail never shows the whole local part', () => {
      expect(maskEmail('nguyen@gmail.com')).toBe('ng***@gmail.com');
      expect(maskEmail('ab@x.vn')).toBe('a***@x.vn');
      expect(maskEmail('a@x.vn')).toBe('***@x.vn');
    });

    it('UTC065: without mail config dev logs the code, production answers 503 and keeps nothing', async () => {
      email.isConfigured.mockReturnValue(false);
      const log = jest
        .spyOn(Logger.prototype, 'log')
        .mockImplementation(() => undefined);
      await send();
      expect(email.sendOtpEmail).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(
        expect.stringMatching(
          /\[DEV OTP\] verify-email anna@mail\.com -> \d{6}/,
        ),
      );
      log.mockRestore();

      const env = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        redis.store.clear();
        await expectRejects(
          send(),
          ServiceUnavailableException,
          'EMAIL_NOT_CONFIGURED',
        );
        expect(redis.store.size).toBe(0);
      } finally {
        process.env.NODE_ENV = env;
      }
    });

    it('UTC066: DEV_BYPASS passes outside production, an empty code does not, and production refuses the bypass', async () => {
      await send();
      await expectRejects(
        otp.verify(OtpPurpose.VERIFY_EMAIL, 'U1', 'c1', ''),
        BadRequestException,
        'OTP_INVALID',
      );
      await expect(
        otp.verify(OtpPurpose.VERIFY_EMAIL, 'U1', 'c1', 'DEV_BYPASS'),
      ).resolves.toBe(true);

      const env = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        await expectRejects(
          otp.verify(OtpPurpose.VERIFY_EMAIL, 'U1', 'c1', 'DEV_BYPASS'),
          BadRequestException,
          'OTP_EXPIRED',
        );
      } finally {
        process.env.NODE_ENV = env;
      }
    });

    it('UTC067: burn answers true once and false after', async () => {
      await expect(otp.burn('x', 60)).resolves.toBe(true);
      await expect(otp.burn('x', 60)).resolves.toBe(false);
      await expect(otp.burn('y', 60)).resolves.toBe(true);
    });
  });

  describe('Email OTP - login', () => {
    it('UTC068: login by phone, by email (lower-cased, deleted rows excluded) and by the legacy phoneNumber field', async () => {
      prisma.user.findFirst.mockResolvedValue(userRow());
      await service.login({ identifier: '0912345678', password: 'Abc@12345' });
      expect(prisma.user.findFirst.mock.calls[0][0].where).toEqual({
        phoneNumber: '0912345678',
      });
      await service.login({
        identifier: ' Anna@Mail.com ',
        password: 'Abc@12345',
      });
      expect(prisma.user.findFirst.mock.calls[1][0].where).toEqual({
        email: 'anna@mail.com',
        status: { not: 'DELETED' },
      });
      const res = await service.login({
        phoneNumber: '0912345678',
        password: 'Abc@12345',
      });
      expect(prisma.user.findFirst.mock.calls[2][0].where).toEqual({
        phoneNumber: '0912345678',
      });
      expect(res).toEqual(
        expect.objectContaining({
          accessToken: expect.any(String),
          refreshToken: 'refresh-token',
        }),
      );
    });

    it('UTC069: a verified account gets tokens and no email is sent', async () => {
      prisma.user.findFirst.mockResolvedValue(userRow());
      const res = await service.login(
        { identifier: '0912345678', password: 'Abc@12345' },
        'Chrome',
      );
      expect(res).not.toHaveProperty('requiresOtp');
      expect(res).toHaveProperty('accessToken');
      expect(res).toHaveProperty('user');
      expect((res as { user: object }).user).not.toHaveProperty('password');
      expect(refreshTokens.issue).toHaveBeenCalledWith('U1', 'Chrome');
      expect(prisma.user.update.mock.calls[0][0].data).toHaveProperty(
        'lastLogin',
      );
      expect(email.sendOtpEmail).not.toHaveBeenCalled();
    });

    it('UTC070: an unverified account gets an OTP challenge and no token', async () => {
      prisma.user.findFirst.mockResolvedValue(unverified());
      const res = await service.login({
        identifier: '0912345678',
        password: 'Abc@12345',
      });
      expect(res).toEqual(
        expect.objectContaining({
          requiresOtp: true,
          challengeToken: expect.any(String),
          sentTo: 'an***@mail.com',
        }),
      );
      expect(res).not.toHaveProperty('accessToken');
      expect(refreshTokens.issue).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(email.sendOtpEmail).toHaveBeenCalledTimes(1);
    });

    it('UTC071: logging in again inside the cooldown rebinds the code instead of mailing another or failing', async () => {
      prisma.user.findFirst.mockResolvedValue(unverified());
      const a = (await service.login({
        identifier: '0912345678',
        password: 'Abc@12345',
      })) as { challengeToken: string };
      const b = (await service.login({
        identifier: '0912345678',
        password: 'Abc@12345',
      })) as { challengeToken: string };
      expect(email.sendOtpEmail).toHaveBeenCalledTimes(1);
      prisma.user.findUnique.mockResolvedValue(unverified());
      prisma.user.update.mockResolvedValue(userRow());
      await expectRejects(
        service.verifyLoginOtp({
          challengeToken: a.challengeToken,
          otpCode: emailed(),
        }),
        BadRequestException,
        'OTP_EXPIRED',
      );
      await expect(
        service.verifyLoginOtp({
          challengeToken: b.challengeToken,
          otpCode: emailed(),
        }),
      ).resolves.toHaveProperty('accessToken');
    });

    it('UTC072: a wrong password, an unknown account and a locked account all answer 401 and send nothing', async () => {
      prisma.user.findFirst.mockResolvedValue(unverified());
      await expectRejects(
        service.login({ identifier: '0912345678', password: 'nope' }),
        UnauthorizedException,
        'INVALID_CREDENTIALS',
        'Invalid phone number, email or password',
      );
      prisma.user.findFirst.mockResolvedValue(null);
      await expectRejects(
        service.login({ identifier: 'x@mail.com', password: 'Abc@12345' }),
        UnauthorizedException,
        'INVALID_CREDENTIALS',
      );
      prisma.user.findFirst.mockResolvedValue(userRow({ status: 'INACTIVE' }));
      await expectRejects(
        service.login({ identifier: '0912345678', password: 'Abc@12345' }),
        UnauthorizedException,
        'INVALID_CREDENTIALS',
      );
      await expectRejects(
        service.login({ password: 'Abc@12345' }),
        UnauthorizedException,
        'INVALID_CREDENTIALS',
      );
      expect(email.sendOtpEmail).not.toHaveBeenCalled();
      expect(redis.store.size).toBe(0);
    });

    it('UTC073: an unverified account without an email answers 403 ACCOUNT_EMAIL_MISSING', async () => {
      prisma.user.findFirst.mockResolvedValue(unverified({ email: null }));
      await expectRejects(
        service.login({ identifier: '0912345678', password: 'Abc@12345' }),
        ForbiddenException,
        'ACCOUNT_EMAIL_MISSING',
      );
      expect(email.sendOtpEmail).not.toHaveBeenCalled();
    });
  });

  describe('Email OTP - verify-otp and resend', () => {
    const startLogin = async () => {
      prisma.user.findFirst.mockResolvedValue(unverified());
      prisma.user.findUnique.mockResolvedValue(unverified());
      prisma.user.update.mockResolvedValue(userRow());
      const res = (await service.login({
        identifier: '0912345678',
        password: 'Abc@12345',
      })) as { challengeToken: string };
      return res.challengeToken;
    };

    it('UTC074: the right code verifies the email and issues the session', async () => {
      const challengeToken = await startLogin();
      const res = await service.verifyLoginOtp(
        { challengeToken, otpCode: emailed() },
        'Chrome',
      );
      expect(res.accessToken).toEqual(expect.any(String));
      expect(res.refreshToken).toBe('refresh-token');
      expect(refreshTokens.issue).toHaveBeenCalledWith('U1', 'Chrome');
      const data = prisma.user.update.mock.calls[0][0].data;
      expect(data.emailVerifiedAt).toBeInstanceOf(Date);
      expect(data.lastLogin).toBeInstanceOf(Date);
    });

    it('UTC075: a challenge cannot be replayed, not even with DEV_BYPASS', async () => {
      const challengeToken = await startLogin();
      await service.verifyLoginOtp({ challengeToken, otpCode: 'DEV_BYPASS' });
      await expectRejects(
        service.verifyLoginOtp({ challengeToken, otpCode: 'DEV_BYPASS' }),
        BadRequestException,
        'OTP_CHALLENGE_INVALID',
      );
      expect(refreshTokens.issue).toHaveBeenCalledTimes(1);
    });

    it('UTC076: a real code cannot be replayed either', async () => {
      const challengeToken = await startLogin();
      const code = emailed();
      await service.verifyLoginOtp({ challengeToken, otpCode: code });
      await expectRejects(
        service.verifyLoginOtp({ challengeToken, otpCode: code }),
        BadRequestException,
        'OTP_EXPIRED',
      );
    });

    it('UTC077: a wrong code is refused and issues nothing', async () => {
      const challengeToken = await startLogin();
      await expectRejects(
        service.verifyLoginOtp({
          challengeToken,
          otpCode: emailed() === '000000' ? '111111' : '000000',
        }),
        BadRequestException,
        'OTP_INVALID',
      );
      expect(refreshTokens.issue).not.toHaveBeenCalled();
    });

    it('UTC078: tokens of the wrong kind or purpose are not accepted as a challenge', async () => {
      const claims = { sub: 'U1', jti: 'j1' };
      const tokens = [
        'garbage',
        jwt.sign({ sub: 'U1' }), // token truy cập
        jwt.sign({ ...claims, type: 'password_reset' }), // token đặt lại mật khẩu
        jwt.sign({
          ...claims,
          type: 'otp_challenge',
          purpose: 'reset-password',
        }),
        jwt.sign({ ...claims, type: 'otp_challenge', purpose: 'bogus' }),
        jwt.sign({ type: 'otp_challenge', purpose: 'verify-email', jti: 'j1' }),
        jwt.sign({ sub: 'U1', type: 'otp_challenge', purpose: 'verify-email' }),
        jwt.sign(
          { ...claims, type: 'otp_challenge', purpose: 'verify-email' },
          { expiresIn: -10 },
        ),
      ];
      for (const challengeToken of tokens)
        await expectRejects(
          service.verifyLoginOtp({ challengeToken, otpCode: '123456' }),
          BadRequestException,
          'OTP_CHALLENGE_INVALID',
        );
      // Ngược lại: challenge verify-email không dùng được ở bước quên mật khẩu.
      const challengeToken = await startLogin();
      await expectRejects(
        service.verifyForgotPasswordOtp({ challengeToken, otpCode: '123456' }),
        BadRequestException,
        'OTP_CHALLENGE_INVALID',
      );
    });

    it('UTC079: an account locked after the challenge cannot exchange it', async () => {
      const challengeToken = await startLogin();
      prisma.user.findUnique.mockResolvedValue(
        unverified({ status: 'INACTIVE' }),
      );
      await expectRejects(
        service.verifyLoginOtp({ challengeToken, otpCode: emailed() }),
        UnauthorizedException,
        'ACCOUNT_INACTIVE',
      );
    });

    it('UTC080: resend inside the cooldown answers 429, after it mails a fresh code for the same challenge', async () => {
      const challengeToken = await startLogin();
      let caught: unknown;
      try {
        await service.resendOtp({ challengeToken });
      } catch (e) {
        caught = e;
      }
      expect((caught as HttpException).getStatus()).toBe(429);

      const t0 = Date.now();
      const spy = jest.spyOn(Date, 'now').mockReturnValue(t0 + 61_000);
      try {
        const res = await service.resendOtp({ challengeToken });
        expect(res).toEqual({
          sentTo: 'an***@mail.com',
          expiresInSeconds: 300,
          resendAfterSeconds: 60,
        });
        expect(email.sendOtpEmail).toHaveBeenCalledTimes(2);
      } finally {
        spy.mockRestore();
      }
      await expect(
        service.verifyLoginOtp({ challengeToken, otpCode: emailed() }),
      ).resolves.toHaveProperty('accessToken');
    });

    it('UTC081: resend refuses a challenge whose account is gone, locked or already verified', async () => {
      const challengeToken = await startLogin();
      prisma.user.findUnique.mockResolvedValue(null);
      await expectRejects(
        service.resendOtp({ challengeToken }),
        BadRequestException,
        'OTP_CHALLENGE_INVALID',
      );
      prisma.user.findUnique.mockResolvedValue(
        unverified({ status: 'SUSPENDED' }),
      );
      await expectRejects(
        service.resendOtp({ challengeToken }),
        BadRequestException,
        'OTP_CHALLENGE_INVALID',
      );
      prisma.user.findUnique.mockResolvedValue(userRow());
      await expectRejects(
        service.resendOtp({ challengeToken }),
        BadRequestException,
        'OTP_CHALLENGE_INVALID',
      );
    });
  });

  describe('Email OTP - forgot password and reset token', () => {
    it('UTC082: an account without an email cannot receive a reset code', async () => {
      prisma.user.findFirst.mockResolvedValue(userRow({ email: null }));
      await expectRejects(
        service.sendForgotPasswordOtp({ identifier: '0912345678' }),
        ForbiddenException,
        'ACCOUNT_EMAIL_MISSING',
      );
    });

    it('UTC083: verifying a reset code also marks the mailbox as verified', async () => {
      prisma.user.findFirst.mockResolvedValue(unverified());
      const { challengeToken } = await service.sendForgotPasswordOtp({
        identifier: 'anna@mail.com',
      });
      prisma.user.findUnique.mockResolvedValue(unverified());
      await service.verifyForgotPasswordOtp({
        challengeToken,
        otpCode: emailed(),
      });
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'U1' },
        data: { emailVerifiedAt: expect.any(Date) },
      });
    });

    it('UTC084: a reset token works once; a second use answers RESET_TOKEN_USED', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'U1', status: 'ACTIVE' });
      const token = jwt.sign(
        { sub: 'U1', type: 'password_reset', jti: 'r-once' },
        { expiresIn: '15m' },
      );
      await service.resetPassword({ token, newPassword: 'Abc@12345' });
      await expectRejects(
        service.resetPassword({ token, newPassword: 'Zzz@12345' }),
        BadRequestException,
        'RESET_TOKEN_USED',
      );
      expect(prisma.user.update).toHaveBeenCalledTimes(1);
    });

    it('UTC085: a reset token without a jti is refused', async () => {
      await expectRejects(
        service.resetPassword({
          token: jwt.sign({ sub: 'U1', type: 'password_reset' }),
          newPassword: 'Abc@12345',
        }),
        BadRequestException,
        'RESET_TOKEN_WRONG_TYPE',
      );
    });
  });

  describe('Email OTP - other entry points', () => {
    it('UTC086: an OTP challenge or reset token is not accepted as an access token', async () => {
      const strategy = new JwtStrategy({} as never, {} as never);
      for (const type of ['otp_challenge', 'password_reset'])
        await expect(strategy.validate({ sub: 'U1', type })).rejects.toThrow(
          UnauthorizedException,
        );
    });

    it('UTC087: Google sign-in verifies the email and ignores deleted accounts in the lookup', async () => {
      firebase.verifyIdToken.mockResolvedValue({
        email: 'Anna@Mail.com',
        email_verified: true,
      });
      prisma.user.findFirst.mockResolvedValue(unverified());
      prisma.user.update.mockResolvedValue(userRow());
      const res = await service.firebaseLogin({ idToken: 't' });
      expect(prisma.user.findFirst.mock.calls[0][0].where).toEqual({
        email: 'anna@mail.com',
        status: { not: 'DELETED' },
      });
      expect(prisma.user.update.mock.calls[0][0].data.emailVerifiedAt).toEqual(
        expect.any(Date),
      );
      expect(res.accessToken).toEqual(expect.any(String));
    });

    it('UTC088: changing the email through /auth/me clears the verification, keeping it does not', async () => {
      const authUser = { userId: 'U1', systemRole: 'TENANT_OWNER' } as never;
      prisma.user.findUnique.mockResolvedValue({ email: 'anna@mail.com' });
      prisma.user.update.mockResolvedValue(userRow());
      await service.updateMe(authUser, { email: 'anna@mail.com' });
      expect(prisma.user.update.mock.calls[0][0].data).not.toHaveProperty(
        'emailVerifiedAt',
      );
      await service.updateMe(authUser, { email: 'new@mail.com' });
      expect(
        prisma.user.update.mock.calls[1][0].data.emailVerifiedAt,
      ).toBeNull();
      expect(prisma.user.findFirst).toHaveBeenLastCalledWith({
        where: {
          email: 'new@mail.com',
          id: { not: 'U1' },
          status: { not: 'DELETED' },
        },
      });
    });
  });
});

// ── RefreshTokens: RefreshTokenService (UTC038-UTC050) ──
describe('RefreshTokenService', () => {
  let redis: ReturnType<typeof fakeRedis>;
  let realtime: { disconnectUser: jest.Mock };
  let jwt: JwtService;
  let service: RefreshTokenService;

  beforeEach(() => {
    redis = fakeRedis();
    realtime = { disconnectUser: jest.fn() };
    jwt = new JwtService({ secret: SECRET });
    service = new RefreshTokenService(jwt, redis as never, realtime as never);
  });

  const keyOf = (token: string) => {
    const { sub, jti } = jwt.verify<{ sub: string; jti: string }>(token);
    return `refresh:${sub}:${jti}`;
  };

  describe('Excel sheet Auth - issue', () => {
    it('UTC038: stores the session for seven days and returns a refresh JWT', async () => {
      const token = await service.issue('u1', 'Chrome');
      const payload = jwt.verify<{ sub: string; jti: string; type: string }>(
        token,
      );
      expect(payload).toEqual(
        expect.objectContaining({
          sub: 'u1',
          type: 'refresh',
          jti: expect.any(String),
        }),
      );
      expect(redis.set).toHaveBeenCalledWith(
        `refresh:u1:${payload.jti}`,
        expect.any(String),
        604800,
      );
      expect(JSON.parse(redis.store.get(keyOf(token))!)).toEqual(
        expect.objectContaining({ userId: 'u1', userAgent: 'Chrome' }),
      );
    });
    it('UTC039: without Redis the token is still returned but not stored, and a warning is logged', async () => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      redis.set.mockResolvedValue(false);
      const token = await service.issue('u1');
      expect(token).toEqual(expect.any(String));
      expect(redis.store.size).toBe(0);
      expect(warn).toHaveBeenCalledWith(
        'Refresh token was not stored (Redis unavailable) - session will not be refreshable',
      );
      warn.mockRestore();
    });
  });

  describe('Excel sheet Auth - rotate', () => {
    it('UTC040: swaps the token, deletes the old session and keeps the user agent', async () => {
      const first = await service.issue('u1', 'Chrome');
      const oldKey = keyOf(first);
      const res = await service.rotate(first);
      expect(res.userId).toBe('u1');
      expect(redis.store.has(oldKey)).toBe(false);
      expect(
        JSON.parse(redis.store.get(keyOf(res.refreshToken))!).userAgent,
      ).toBe('Chrome');
    });
    it('UTC041: a token used a second time is refused', async () => {
      const first = await service.issue('u1');
      await service.rotate(first);
      await expectRejects(
        service.rotate(first),
        UnauthorizedException,
        'SESSION_EXPIRED',
        'Your session has expired or was revoked, please sign in again',
      );
    });
    it('UTC042: a string that is not a JWT', async () => {
      await expectRejects(
        service.rotate('abc'),
        UnauthorizedException,
        'REFRESH_TOKEN_INVALID',
        'Invalid refresh token',
      );
    });
    it('UTC043: an expired refresh token', async () => {
      const expired = jwt.sign(
        { sub: 'u1', jti: 'j1', type: 'refresh' },
        { expiresIn: -10 },
      );
      await expectRejects(
        service.rotate(expired),
        UnauthorizedException,
        'REFRESH_TOKEN_INVALID',
      );
    });
    it('UTC044: an access token cannot be used as a refresh token', async () => {
      await expectRejects(
        service.rotate(jwt.sign({ sub: 'u1' })),
        UnauthorizedException,
        'REFRESH_TOKEN_INVALID',
      );
    });
    it('UTC045: without Redis no session is found', async () => {
      const first = await service.issue('u1');
      redis.store.clear();
      await expectRejects(
        service.rotate(first),
        UnauthorizedException,
        'SESSION_EXPIRED',
      );
    });
  });

  describe('Excel sheet Auth - revoke', () => {
    it('UTC046: the owner revokes the session', async () => {
      const token = await service.issue('u1');
      await service.revoke('u1', token);
      expect(redis.store.size).toBe(0);
    });
    it("UTC047: another user's token is left alone", async () => {
      const token = await service.issue('u2');
      await service.revoke('u1', token);
      expect(redis.store.size).toBe(1);
    });
    it('UTC048: an invalid token is ignored silently', async () => {
      await service.issue('u1');
      await expect(service.revoke('u1', 'abc')).resolves.toBeUndefined();
      expect(redis.store.size).toBe(1);
    });
  });

  describe('Excel sheet Auth - revokeAllFor', () => {
    it('UTC049: deletes every session of the user and closes the live connections', async () => {
      await service.issue('u1');
      await service.issue('u1');
      await service.issue('u1');
      await service.issue('u2');
      await service.revokeAllFor('u1');
      expect(redis.keysMatching).toHaveBeenCalledWith('refresh:u1:*');
      expect(
        [...redis.store.keys()].every((k) => k.startsWith('refresh:u2:')),
      ).toBe(true);
      expect(redis.store.size).toBe(1);
      expect(realtime.disconnectUser).toHaveBeenCalledWith('u1');
    });
    it('UTC050: with no session the live connections are still closed', async () => {
      await service.revokeAllFor('u1');
      expect(redis.store.size).toBe(0);
      expect(realtime.disconnectUser).toHaveBeenCalledWith('u1');
    });
  });
});
