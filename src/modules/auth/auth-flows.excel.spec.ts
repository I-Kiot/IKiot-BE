import {
  BadRequestException,
  ConflictException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { AuthService } from './auth.service';
import { OtpService } from './otp.service';
import { RefreshTokenService } from './refresh-token.service';

const bodyOf = (error: unknown) =>
  (error as BadRequestException).getResponse() as {
    code: string;
    message: string;
  };

/** Expects `run` to reject with `type`, carrying `code` (and `message` when given). */
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

/** In-memory stand-in for RedisService (a Map with the four methods the services use). */
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
    otp = new OtpService({} as never, redis as never);
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

  const storeOtp = (phone: string, code: string) =>
    redis.store.set(`otp:register:${phone.replace(/^0/, '+84')}`, code);

  // ── Auth: register (UTC008-UTC013) ──
  describe('Excel sheet Auth - register', () => {
    const dto = (over: Record<string, unknown> = {}) => ({
      phoneNumber: '0987000010',
      tenantName: 'Cua hang A',
      otpCode: '123456',
      password: 'Abc@12345',
      email: 'a@mail.com',
      firstName: 'A',
      lastName: 'Nguyen',
      ...over,
    });

    it('UTC008: creates the tenant and its active owner in one transaction', async () => {
      storeOtp('0987000010', '123456');
      const res = await service.register(dto() as never, 'Chrome');
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(tx.user.create.mock.calls[0][0].data).toEqual(
        expect.objectContaining({
          tenantId: 'T9',
          phoneNumber: '0987000010',
          systemRole: 'TENANT_OWNER',
          status: 'ACTIVE',
        }),
      );
      expect(
        await bcrypt.compare(
          'Abc@12345',
          tx.user.create.mock.calls[0][0].data.password,
        ),
      ).toBe(true);
      expect(tx.tenant.update).toHaveBeenCalledWith({
        where: { id: 'T9' },
        data: { tenantOwnerId: 'U9' },
      });
      expect(res.accessToken).toEqual(expect.any(String));
      expect(res.refreshToken).toBe('refresh-token');
      expect(res.tenant.id).toBe('T9');
      expect(res.user).not.toHaveProperty('password');
      expect(refreshTokens.issue).toHaveBeenCalledWith('U9', 'Chrome');
    });

    it('UTC009: a phone number that is already registered', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 'U1' });
      await expectRejects(
        service.register(dto() as never),
        ConflictException,
        'PHONE_ALREADY_REGISTERED',
        'Phone number is already registered',
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('UTC010: a tenant name that is already taken', async () => {
      prisma.tenant.findFirst.mockResolvedValue({ id: 'T1' });
      await expectRejects(
        service.register(dto() as never),
        ConflictException,
        'TENANT_NAME_TAKEN',
        'Tenant name is already taken',
      );
    });

    it('UTC011: no OTP was requested or it has expired', async () => {
      await expectRejects(
        service.register(dto() as never),
        BadRequestException,
        'OTP_EXPIRED',
        'OTP has expired or was not requested. Please request a new code.',
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('UTC012: a wrong OTP creates nothing', async () => {
      storeOtp('0987000010', '654321');
      await expectRejects(
        service.register(dto({ otpCode: '000000' }) as never),
        BadRequestException,
        'OTP_INVALID',
        'Invalid OTP code',
      );
      expect(tx.tenant.create).not.toHaveBeenCalled();
      expect(tx.user.create).not.toHaveBeenCalled();
    });

    it('UTC013: phone and tenant name both taken reports the phone first', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 'U1' });
      prisma.tenant.findFirst.mockResolvedValue({ id: 'T1' });
      await expectRejects(
        service.register(dto() as never),
        ConflictException,
        'PHONE_ALREADY_REGISTERED',
      );
    });
  });

  // ── Auth: checkAvailability (UTC014-UTC017) ──
  describe('Excel sheet Auth - checkAvailability', () => {
    it('UTC014: both taken', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 'U1' });
      prisma.tenant.findFirst.mockResolvedValue({ id: 'T1' });
      await expect(
        service.checkAvailability({
          phoneNumber: '0987000010',
          tenantName: 'Cua hang A',
        } as never),
      ).resolves.toEqual({ phoneNumberTaken: true, tenantNameTaken: true });
    });
    it('UTC015: both free', async () => {
      await expect(
        service.checkAvailability({
          phoneNumber: '0987999999',
          tenantName: 'Cua hang Z',
        } as never),
      ).resolves.toEqual({ phoneNumberTaken: false, tenantNameTaken: false });
    });
    it('UTC016: only the phone is checked when no tenant name is sent', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 'U1' });
      await expect(
        service.checkAvailability({ phoneNumber: '0987000010' } as never),
      ).resolves.toEqual({ phoneNumberTaken: true, tenantNameTaken: false });
      expect(prisma.tenant.findFirst).not.toHaveBeenCalled();
    });
    it('UTC017: nothing sent means no query', async () => {
      await expect(service.checkAvailability({} as never)).resolves.toEqual({
        phoneNumberTaken: false,
        tenantNameTaken: false,
      });
      expect(prisma.user.findFirst).not.toHaveBeenCalled();
      expect(prisma.tenant.findFirst).not.toHaveBeenCalled();
    });
  });

  // ── PasswordRecovery: OtpService.verifyOtp (UTC018-UTC022) ──
  describe('Excel sheet Auth - verifyOtp', () => {
    it('UTC018: the correct OTP is accepted and deleted', async () => {
      storeOtp('0912345678', '123456');
      await expect(otp.verifyOtp('0912345678', '123456')).resolves.toBe(true);
      expect(redis.store.size).toBe(0);
    });
    it('UTC019: a wrong OTP is refused', async () => {
      storeOtp('0912345678', '123456');
      await expectRejects(
        otp.verifyOtp('0912345678', '000000'),
        BadRequestException,
        'OTP_INVALID',
        'Invalid OTP code',
      );
    });
    it('UTC020: no stored OTP means it expired or was never requested', async () => {
      await expectRejects(
        otp.verifyOtp('0912345678', '123456'),
        BadRequestException,
        'OTP_EXPIRED',
        'OTP has expired or was not requested. Please request a new code.',
      );
    });
    it('UTC021: an OTP can be used only once', async () => {
      storeOtp('0912345678', '123456');
      await otp.verifyOtp('0912345678', '123456');
      await expectRejects(
        otp.verifyOtp('0912345678', '123456'),
        BadRequestException,
        'OTP_EXPIRED',
      );
    });
    it('UTC022: the phone number is normalised before lookup', async () => {
      redis.store.set('otp:register:+84912345678', '123456');
      await expect(otp.verifyOtp('0912345678', '123456')).resolves.toBe(true);
    });
  });

  // ── PasswordRecovery: sendForgotPasswordOtp (UTC023-UTC026) ──
  describe('Excel sheet Auth - sendForgotPasswordOtp', () => {
    let sendOtp: jest.Mock;
    beforeEach(() => {
      sendOtp = jest.fn().mockResolvedValue({ sent: true });
      service = new AuthService(
        prisma,
        jwt,
        { sendOtp } as never,
        firebase as never,
        refreshTokens as never,
      );
    });
    const active = { id: 'U1', phoneNumber: '0912345678', status: 'ACTIVE' };

    it('UTC023: an active account gets an OTP', async () => {
      prisma.user.findFirst.mockResolvedValue(active);
      await expect(
        service.sendForgotPasswordOtp({ phoneNumber: '0912345678' } as never),
      ).resolves.toEqual({
        message: 'Đã gửi mã OTP thành công đến số điện thoại của bạn.',
      });
      expect(sendOtp).toHaveBeenCalledWith('0912345678');
    });
    it('UTC024: a blank phone number is refused without a lookup', async () => {
      await expectRejects(
        service.sendForgotPasswordOtp({ phoneNumber: '   ' } as never),
        BadRequestException,
        'PHONE_REQUIRED',
        'Phone number is required',
      );
      expect(prisma.user.findFirst).not.toHaveBeenCalled();
    });
    it('UTC025: an unknown phone number', async () => {
      await expectRejects(
        service.sendForgotPasswordOtp({ phoneNumber: '0900000000' } as never),
        BadRequestException,
        'PHONE_NOT_REGISTERED',
        'This phone number is not registered, or the account is locked.',
      );
      expect(sendOtp).not.toHaveBeenCalled();
    });
    it('UTC026: a locked account gets the same answer as an unknown number', async () => {
      prisma.user.findFirst.mockResolvedValue({
        ...active,
        status: 'SUSPENDED',
      });
      await expectRejects(
        service.sendForgotPasswordOtp({ phoneNumber: '0912345678' } as never),
        BadRequestException,
        'PHONE_NOT_REGISTERED',
        'This phone number is not registered, or the account is locked.',
      );
      expect(sendOtp).not.toHaveBeenCalled();
    });
  });

  // ── PasswordRecovery: verifyForgotPasswordOtp (UTC027-UTC029) ──
  describe('Excel sheet Auth - verifyForgotPasswordOtp', () => {
    const active = { id: 'U1', phoneNumber: '0912345678', status: 'ACTIVE' };
    it('UTC027: a correct OTP returns a 15-minute password_reset token', async () => {
      prisma.user.findFirst.mockResolvedValue(active);
      storeOtp('0912345678', '123456');
      const res = await service.verifyForgotPasswordOtp({
        phoneNumber: '0912345678',
        otpCode: '123456',
      } as never);
      expect(res.message).toBe('Xác thực mã OTP thành công.');
      const payload = jwt.verify<{
        sub: string;
        type: string;
        iat: number;
        exp: number;
      }>(res.resetToken);
      expect(payload.sub).toBe('U1');
      expect(payload.type).toBe('password_reset');
      expect(payload.exp - payload.iat).toBe(15 * 60);
    });
    it('UTC028: a wrong OTP is refused', async () => {
      prisma.user.findFirst.mockResolvedValue(active);
      storeOtp('0912345678', '123456');
      await expectRejects(
        service.verifyForgotPasswordOtp({
          phoneNumber: '0912345678',
          otpCode: '000000',
        } as never),
        BadRequestException,
        'OTP_INVALID',
      );
    });
    it('UTC029: an unknown phone number', async () => {
      await expectRejects(
        service.verifyForgotPasswordOtp({
          phoneNumber: '0900000000',
          otpCode: '123456',
        } as never),
        BadRequestException,
        'PHONE_NOT_REGISTERED',
      );
    });
  });

  // ── PasswordRecovery: resetPassword (UTC030-UTC034) ──
  describe('Excel sheet Auth - resetPassword', () => {
    const resetToken = () =>
      jwt.sign({ sub: 'U1', type: 'password_reset' }, { expiresIn: '15m' });
    it('UTC030: a valid token sets the new password and ends every session', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'U1', status: 'ACTIVE' });
      const res = await service.resetPassword({
        token: resetToken(),
        newPassword: 'Abc@12345',
      } as never);
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
        } as never),
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
        } as never),
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
        } as never),
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
        } as never),
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
