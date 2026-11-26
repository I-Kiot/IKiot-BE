import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { UserService } from './users.service';

const bodyOf = (error: unknown) =>
  (error as NotFoundException).getResponse() as {
    code: string;
    message: string;
  };

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

// Sheet Excel "UsersPermissions" - createAccount, updateAccountPassword, deactivateAccount (UTC009-UTC017).
describe('Excel sheet UsersPermissions - staff account', () => {
  let prisma: any;
  let notifications: { notify: jest.Mock };
  let refreshTokens: { revokeAllFor: jest.Mock };
  let service: UserService;

  const owner = {
    userId: 'U1',
    systemRole: 'TENANT_OWNER',
    tenantId: 'T1',
    permissions: new Set(),
  } as never;
  const staff = (over: Record<string, unknown> = {}) => ({
    id: 'S1',
    tenantId: 'T1',
    systemRole: 'STAFF',
    roleId: null,
    email: 'staff@mail.com',
    status: 'INACTIVE',
    password: null,
    ...over,
  });

  beforeEach(() => {
    prisma = {
      user: {
        findFirst: jest.fn(),
        update: jest
          .fn()
          .mockImplementation(({ data }) =>
            Promise.resolve({ id: 'S1', ...data }),
          ),
      },
      leaveRequest: { count: jest.fn().mockResolvedValue(0) },
      branch: { count: jest.fn().mockResolvedValue(0) },
      warehouse: { count: jest.fn().mockResolvedValue(0) },
    };
    notifications = { notify: jest.fn().mockResolvedValue({ notified: 1 }) };
    refreshTokens = { revokeAllFor: jest.fn().mockResolvedValue(undefined) };
    service = new UserService(
      prisma,
      notifications as never,
      {} as never,
      refreshTokens as never,
    );
  });

  const passwords = {
    newPassword: 'Abc@12345',
    reEnterPassword: 'Abc@12345',
  } as never;

  describe('createAccount', () => {
    it('UTC009: gives an employee without a login an active account', async () => {
      prisma.user.findFirst.mockResolvedValue(staff());
      await service.createAccount(owner, 'T1', 'S1', passwords);
      const data = prisma.user.update.mock.calls[0][0].data;
      expect(data.status).toBe('ACTIVE');
      expect(await bcrypt.compare('Abc@12345', data.password)).toBe(true);
      expect(notifications.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'T1',
          recipientIds: ['S1'],
          referenceId: 'S1',
        }),
      );
    });
    it('UTC010: an employee who already has a login', async () => {
      prisma.user.findFirst.mockResolvedValue(
        staff({ status: 'ACTIVE', password: 'hash' }),
      );
      await expectRejects(
        service.createAccount(owner, 'T1', 'S1', passwords),
        ConflictException,
        'STAFF_ACCOUNT_EXISTS',
        'This employee already has a login',
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
    it('UTC011: an employee that does not exist in the tenant', async () => {
      prisma.user.findFirst.mockResolvedValue(null);
      await expectRejects(
        service.createAccount(owner, 'T1', 'missing', passwords),
        NotFoundException,
        'STAFF_NOT_FOUND',
        'Employee not found',
      );
    });
    it('UTC018: an employee without an email gets no login, and nothing is written', async () => {
      prisma.user.findFirst.mockResolvedValue(staff({ email: null }));
      await expectRejects(
        service.createAccount(owner, 'T1', 'S1', passwords),
        BadRequestException,
        'ACCOUNT_EMAIL_MISSING',
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(notifications.notify).not.toHaveBeenCalled();
    });
  });

  describe('updateAccountPassword', () => {
    it('UTC012: replaces the password and ends the live sessions', async () => {
      prisma.user.findFirst.mockResolvedValue(
        staff({ status: 'ACTIVE', password: 'old' }),
      );
      await service.updateAccountPassword(owner, 'T1', 'S1', {
        newPassword: 'Xyz@12345',
        reEnterPassword: 'Xyz@12345',
      });
      const data = prisma.user.update.mock.calls[0][0].data;
      expect(await bcrypt.compare('Xyz@12345', data.password)).toBe(true);
      expect(refreshTokens.revokeAllFor).toHaveBeenCalledWith('S1');
    });
    it('UTC013: an employee without a login yet', async () => {
      prisma.user.findFirst.mockResolvedValue(
        staff({ status: 'INACTIVE', password: null }),
      );
      await expectRejects(
        service.updateAccountPassword(owner, 'T1', 'S1', passwords),
        BadRequestException,
        'STAFF_ACCOUNT_NOT_ACTIVATED',
        'This employee account has not been activated',
      );
    });
    it('UTC014: a confirmation that does not match', async () => {
      prisma.user.findFirst.mockResolvedValue(
        staff({ status: 'ACTIVE', password: 'old' }),
      );
      await expectRejects(
        service.updateAccountPassword(owner, 'T1', 'S1', {
          newPassword: 'Xyz@12345',
          reEnterPassword: 'Other@123',
        }),
        BadRequestException,
        'PASSWORD_CONFIRMATION_MISMATCH',
        'The password confirmation does not match',
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });

  describe('deactivateAccount', () => {
    it('UTC015: switches the login off, clears the password and ends the sessions', async () => {
      prisma.user.findFirst.mockResolvedValue(
        staff({ status: 'ACTIVE', password: 'hash' }),
      );
      await service.deactivateAccount(owner, 'T1', 'S1');
      expect(prisma.user.update.mock.calls[0][0].data).toEqual({
        status: 'INACTIVE',
        password: null,
      });
      expect(refreshTokens.revokeAllFor).toHaveBeenCalledWith('S1');
    });
    it('UTC016: an account that is already deactivated', async () => {
      prisma.user.findFirst.mockResolvedValue(staff({ status: 'INACTIVE' }));
      await expectRejects(
        service.deactivateAccount(owner, 'T1', 'S1'),
        ConflictException,
        'STAFF_ACCOUNT_ALREADY_DEACTIVATED',
        'This employee account is already deactivated',
      );
      expect(refreshTokens.revokeAllFor).not.toHaveBeenCalled();
    });
    it('UTC017: the manager of a branch cannot be deactivated', async () => {
      prisma.user.findFirst.mockResolvedValue(
        staff({ status: 'ACTIVE', password: 'hash' }),
      );
      prisma.branch.count.mockResolvedValue(1);
      await expectRejects(
        service.deactivateAccount(owner, 'T1', 'S1'),
        ConflictException,
        'STAFF_IS_LOCATION_MANAGER',
        'This employee manages a branch or a warehouse. Appoint somebody else first.',
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });
});
