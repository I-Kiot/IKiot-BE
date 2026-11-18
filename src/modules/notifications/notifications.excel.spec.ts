import { Logger, NotFoundException } from '@nestjs/common';
import { AdminNotificationService } from './admin-notifications.service';
import { NotificationService } from './notifications.service';

const bodyOf = (error: unknown) =>
  (error as NotFoundException).getResponse() as {
    code: string;
    message: string;
  };

// Excel sheet "Notifications" - inbox actions (UTC017-UTC024).
describe('Excel sheet Notifications - NotificationService', () => {
  let prisma: any;
  let service: NotificationService;
  const user = { userId: 'U1', tenantId: 'T1' } as never;
  const inbox = {
    tenantId: 'T1',
    OR: [{ recipientId: 'U1' }, { recipientId: null }],
  };

  beforeEach(() => {
    prisma = {
      notification: {
        updateMany: jest.fn().mockResolvedValue({ count: 3 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        count: jest.fn(),
      },
      userFcmToken: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    service = new NotificationService(prisma, {} as never, {} as never);
  });

  describe('markAllRead', () => {
    it('UTC017: marks the unread notifications of the inbox as read', async () => {
      await expect(service.markAllRead(user)).resolves.toEqual({
        success: true,
      });
      expect(prisma.notification.updateMany).toHaveBeenCalledWith({
        where: { ...inbox, isRead: false },
        data: { isRead: true },
      });
    });
    it('UTC018: with nothing unread it still succeeds', async () => {
      prisma.notification.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.markAllRead(user)).resolves.toEqual({
        success: true,
      });
    });
  });

  describe('unreadCount', () => {
    it('UTC019: counts only unread notifications of the inbox', async () => {
      prisma.notification.count.mockResolvedValue(3);
      await expect(service.unreadCount(user)).resolves.toEqual({ count: 3 });
      expect(prisma.notification.count).toHaveBeenCalledWith({
        where: { ...inbox, isRead: false },
      });
    });
    it('UTC020: an empty inbox counts zero', async () => {
      prisma.notification.count.mockResolvedValue(0);
      await expect(service.unreadCount(user)).resolves.toEqual({ count: 0 });
    });
  });

  describe('deleteOne', () => {
    it('UTC021: deletes a notification of the inbox', async () => {
      await expect(service.deleteOne(user, 'N1')).resolves.toEqual({
        success: true,
      });
      expect(prisma.notification.deleteMany).toHaveBeenCalledWith({
        where: { id: 'N1', ...inbox },
      });
    });
    it("UTC022: another user's notification is not found", async () => {
      prisma.notification.deleteMany.mockResolvedValue({ count: 0 });
      const run = service.deleteOne(user, 'N2');
      await expect(run).rejects.toThrow(NotFoundException);
      await run.catch((error) => {
        expect(bodyOf(error).code).toBe('NOTIFICATION_NOT_FOUND');
        expect(bodyOf(error).message).toBe('Notification not found');
      });
    });
  });

  it('UTC023: deleteAll clears only the inbox of the user', async () => {
    await expect(service.deleteAll(user)).resolves.toEqual({ success: true });
    expect(prisma.notification.deleteMany).toHaveBeenCalledWith({
      where: inbox,
    });
  });

  it("UTC024: removeDeviceToken deletes that user's token only", async () => {
    await expect(service.removeDeviceToken('U1', 'abc')).resolves.toEqual({
      success: true,
    });
    expect(prisma.userFcmToken.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'U1', token: 'abc' },
    });
  });
});

// Excel sheet "Notifications" - AdminNotificationService (UTC025-UTC040).
describe('Excel sheet Notifications - AdminNotificationService', () => {
  let prisma: any;
  let email: { sendSystemNotificationEmail: jest.Mock };
  let service: AdminNotificationService;
  const SYSTEM_FILTER = {
    tenantId: null,
    recipientId: null,
    type: { in: expect.any(Array) },
  };

  beforeEach(() => {
    prisma = {
      notification: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn().mockResolvedValue({ id: 'N1', isRead: true }),
        create: jest
          .fn()
          .mockImplementation(({ data }) =>
            Promise.resolve({ id: 'A1', ...data }),
          ),
      },
      user: { findMany: jest.fn().mockResolvedValue([]) },
    };
    email = {
      sendSystemNotificationEmail: jest.fn().mockResolvedValue(undefined),
    };
    service = new AdminNotificationService(prisma, email as never);
  });

  describe('listSystem', () => {
    it('UTC025: lists only system events, newest first, with the total', async () => {
      prisma.notification.findMany.mockResolvedValue([
        { id: 'N1' },
        { id: 'N2' },
      ]);
      prisma.notification.count.mockResolvedValue(2);
      const res = await service.listSystem({ page: 1, limit: 10 } as never);
      expect(prisma.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: SYSTEM_FILTER,
          orderBy: { createdAt: 'desc' },
          skip: 0,
          take: 10,
        }),
      );
      const where = prisma.notification.findMany.mock.calls[0][0].where;
      expect(where.type.in).not.toContain('ANNOUNCEMENT');
      expect(JSON.stringify(res)).toContain('"total":2');
    });
    it('UTC026: no system event gives an empty page', async () => {
      const res = await service.listSystem({ page: 1, limit: 10 } as never);
      expect(JSON.stringify(res)).toContain('"total":0');
    });
  });

  describe('markSystemRead', () => {
    it('UTC027: marks a system event as read', async () => {
      await expect(service.markSystemRead('N1')).resolves.toEqual({
        id: 'N1',
        isRead: true,
      });
      expect(prisma.notification.updateMany).toHaveBeenCalledWith({
        where: { id: 'N1', ...SYSTEM_FILTER },
        data: { isRead: true },
      });
    });
    it('UTC028: a shop notification is not found and stays unchanged', async () => {
      prisma.notification.updateMany.mockResolvedValue({ count: 0 });
      const run = service.markSystemRead('SHOP1');
      await expect(run).rejects.toThrow(NotFoundException);
      await run.catch((error) => {
        expect(bodyOf(error).code).toBe('NOTIFICATION_NOT_FOUND');
        expect(bodyOf(error).message).toBe('Notification not found');
      });
    });
    it('UTC029: an announcement is not part of the system feed', async () => {
      prisma.notification.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.markSystemRead('ANN1')).rejects.toThrow(
        NotFoundException,
      );
      const where = prisma.notification.updateMany.mock.calls[0][0].where;
      expect(where.type.in).not.toContain('ANNOUNCEMENT');
    });
  });

  describe('markAllSystemRead', () => {
    it('UTC030: marks every unread system event and reports the count', async () => {
      prisma.notification.updateMany.mockResolvedValue({ count: 3 });
      await expect(service.markAllSystemRead()).resolves.toEqual({
        message: 'Đã đánh dấu tất cả là đã đọc',
        updated: 3,
      });
      expect(prisma.notification.updateMany).toHaveBeenCalledWith({
        where: { ...SYSTEM_FILTER, isRead: false },
        data: { isRead: true },
      });
    });
    it('UTC031: with nothing unread it reports zero', async () => {
      prisma.notification.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.markAllSystemRead()).resolves.toEqual(
        expect.objectContaining({ updated: 0 }),
      );
    });
  });

  describe('removeSystem', () => {
    it('UTC032: deletes a system event', async () => {
      await expect(service.removeSystem('N1')).resolves.toEqual({
        message: 'Đã xoá thông báo',
      });
    });
    it('UTC033: a shop notification is not found', async () => {
      prisma.notification.deleteMany.mockResolvedValue({ count: 0 });
      const run = service.removeSystem('SHOP1');
      await expect(run).rejects.toThrow(NotFoundException);
      await run.catch((error) =>
        expect(bodyOf(error).code).toBe('NOTIFICATION_NOT_FOUND'),
      );
    });
    it('UTC034: removeAllSystem deletes only the system feed and reports the count', async () => {
      prisma.notification.deleteMany.mockResolvedValue({ count: 4 });
      await expect(service.removeAllSystem()).resolves.toEqual({
        message: 'Đã xoá toàn bộ thông báo hệ thống',
        deleted: 4,
      });
      expect(prisma.notification.deleteMany).toHaveBeenCalledWith({
        where: SYSTEM_FILTER,
      });
    });
  });

  describe('compose', () => {
    const owners = (list: Array<string | null>) =>
      prisma.user.findMany.mockResolvedValue(list.map((e) => ({ email: e })));
    const dto = (over: Record<string, unknown> = {}) => ({
      title: 'Bao tri',
      description: 'Noi dung',
      category: 'INFO',
      targetType: 'ALL',
      ...over,
    });

    it('UTC035: to all shops emails every eligible owner and records the announcement first', async () => {
      owners(['a@mail.com', 'b@mail.com']);
      const res = await service.compose('ADMIN1', dto() as never);
      expect(prisma.notification.create.mock.calls[0][0].data).toEqual(
        expect.objectContaining({
          type: 'ANNOUNCEMENT',
          targetType: 'ALL',
          createdById: 'ADMIN1',
          targetTenants: { create: [] },
        }),
      );
      expect(prisma.user.findMany.mock.calls[0][0].where).toEqual({
        systemRole: 'TENANT_OWNER',
        status: 'ACTIVE',
        email: { not: null },
      });
      expect(email.sendSystemNotificationEmail).toHaveBeenCalledTimes(2);
      expect(res.message).toBe(
        'Thông báo đã được xếp lịch gửi tới 2 chủ cửa hàng.',
      );
      expect(
        prisma.notification.create.mock.invocationCallOrder[0],
      ).toBeLessThan(prisma.user.findMany.mock.invocationCallOrder[0]);
    });
    it('UTC036: a selection records the chosen shops and emails only their owners', async () => {
      owners(['a@mail.com']);
      const res = await service.compose(
        'ADMIN1',
        dto({ targetType: 'SELECTION', targetTenants: ['TA'] }) as never,
      );
      expect(
        prisma.notification.create.mock.calls[0][0].data.targetTenants,
      ).toEqual({
        create: [{ tenantId: 'TA' }],
      });
      expect(prisma.user.findMany.mock.calls[0][0].where.tenantId).toEqual({
        in: ['TA'],
      });
      expect(res.message).toContain('1 chủ cửa hàng');
    });
    it('UTC037: targetTenants is ignored when the target is ALL', async () => {
      owners(['a@mail.com', 'b@mail.com']);
      await service.compose('ADMIN1', dto({ targetTenants: ['TA'] }) as never);
      expect(
        prisma.notification.create.mock.calls[0][0].data.targetTenants,
      ).toEqual({
        create: [],
      });
      expect(prisma.user.findMany.mock.calls[0][0].where).not.toHaveProperty(
        'tenantId',
      );
    });
    it('UTC038: a failed email does not fail the announcement', async () => {
      const logged = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      owners(['a@mail.com']);
      email.sendSystemNotificationEmail.mockRejectedValue(
        new Error('smtp down'),
      );
      const res = await service.compose('ADMIN1', dto() as never);
      await new Promise((resolve) => setImmediate(resolve));
      expect(res.data).toEqual(expect.objectContaining({ id: 'A1' }));
      expect(logged).toHaveBeenCalled();
      logged.mockRestore();
    });
    it('UTC039: with no eligible owner the announcement is still stored', async () => {
      owners([]);
      const res = await service.compose(
        'ADMIN1',
        dto({ targetType: 'SELECTION', targetTenants: ['TC'] }) as never,
      );
      expect(prisma.notification.create).toHaveBeenCalledTimes(1);
      expect(email.sendSystemNotificationEmail).not.toHaveBeenCalled();
      expect(res.message).toBe(
        'Thông báo đã được xếp lịch gửi tới 0 chủ cửa hàng.',
      );
    });
  });

  it('UTC040: listAnnouncements lists announcements newest first', async () => {
    prisma.notification.findMany.mockResolvedValue([{ id: 'A1' }]);
    prisma.notification.count.mockResolvedValue(1);
    await service.listAnnouncements({ page: 1, limit: 10 } as never);
    expect(prisma.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { type: 'ANNOUNCEMENT' },
        orderBy: { createdAt: 'desc' },
        include: expect.objectContaining({
          targetTenants: expect.anything(),
          createdBy: expect.anything(),
        }),
      }),
    );
  });
});
