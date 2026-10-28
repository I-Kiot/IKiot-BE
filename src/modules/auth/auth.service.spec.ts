import { UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { AuthService } from './auth.service';

// Excel sheet "Auth" - login (UTC001-UTC007).
describe('AuthService.login', () => {
  const PASSWORD = 'Abc@12345';
  let hash: string;
  let prisma: { user: { findFirst: jest.Mock; update: jest.Mock } };
  let service: AuthService;

  beforeAll(async () => {
    hash = await bcrypt.hash(PASSWORD, 4);
  });

  beforeEach(() => {
    prisma = { user: { findFirst: jest.fn(), update: jest.fn() } };
    const jwt = { sign: jest.fn().mockReturnValue('access-token') };
    const refresh = { issue: jest.fn().mockResolvedValue('refresh-token') };
    service = new AuthService(
      prisma as never,
      jwt as never,
      {} as never,
      {} as never,
      refresh as never,
    );
  });

  const user = (over: Record<string, unknown>) => ({
    id: 'U1',
    phoneNumber: '0912345678',
    password: hash,
    status: 'ACTIVE',
    ...over,
  });

  const expectInvalid = async (phoneNumber: string, password: string) => {
    const p = service.login({ phoneNumber, password } as never);
    await expect(p).rejects.toThrow(UnauthorizedException);
    await expect(p).rejects.toThrow('Invalid phone number or password');
  };

  it('UTC001: no account with the phone number', async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    await expectInvalid('0987000001', PASSWORD);
  });

  it('UTC002: account has no password set', async () => {
    prisma.user.findFirst.mockResolvedValue(user({ password: null }));
    await expectInvalid('0912345678', PASSWORD);
  });

  it.each([
    ['UTC003', 'SUSPENDED', '0912345679'],
    ['UTC004', 'INACTIVE', '0912345680'],
    ['UTC005', 'DELETED', '0912345681'],
  ])('%s: status %s is rejected', async (_id, status, phone) => {
    prisma.user.findFirst.mockResolvedValue(
      user({ status, phoneNumber: phone }),
    );
    await expectInvalid(phone, PASSWORD);
  });

  it('UTC006: wrong password', async () => {
    prisma.user.findFirst.mockResolvedValue(user({}));
    await expectInvalid('0912345678', 'SaiMatKhau999');
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('UTC007: valid credentials succeed', async () => {
    prisma.user.findFirst.mockResolvedValue(user({}));
    const res = await service.login({
      phoneNumber: '0912345678',
      password: PASSWORD,
    } as never);
    expect(res.accessToken).toBe('access-token');
    expect(res.refreshToken).toBe('refresh-token');
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
  });
});
