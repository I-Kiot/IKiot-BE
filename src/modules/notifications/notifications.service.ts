import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { UserStatus } from '../../common/constants/user-status';
import { SystemRole } from '../../common/constants/system-role';
import { RealtimeGateway } from '../../common/realtime/realtime.gateway';
import { PushService } from '../../common/push/push.service';
import type { AuthUser } from '../../common/types/auth-user.type';
import type { NotificationContent } from './notification-content.type';
import { ErrorCode } from '../../common/errors/error-codes';

export interface NotifyInput extends NotificationContent {
  tenantId: string | null;
  recipientIds: (string | null | undefined)[];
  referenceId?: string;
}

// Ported from notificationService.js (fan-out) + the notification module (inbox API), merged here. Put new notification copy in a `templates/*.templates.ts` file, never inline.
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
    private readonly push: PushService,
  ) {}

  // ─── Fan-out ───────────────────────────────────────────────────────────────

  // Never throws - a notification failing must not break the transaction that triggered it. Three channels in one call: the Notification row (the inbox and unread badge), a Socket.IO emit for an open tab, and an FCM push for a closed one. The push is awaited, as in iKiotMS-BE: notify() runs after the transaction has committed, so it delays a response rather than holding a lock, and the ordering stays testable.
  async notify(input: NotifyInput): Promise<{ notified: number }> {
    try {
      const ids = [
        ...new Set(
          input.recipientIds.filter((id): id is string => Boolean(id)),
        ),
      ];
      if (ids.length === 0) return { notified: 0 };

      // Independent inserts, deliberately not in a transaction - one recipient's write failing shouldn't roll back a notification the others already received.
      const docs = await Promise.all(
        ids.map((recipientId) =>
          this.prisma.notification.create({
            data: {
              tenantId: input.tenantId,
              recipientId,
              type: input.type,
              title: input.title,
              description: input.description,
              link: input.link,
              referenceId: input.referenceId,
              isRead: false,
            },
          }),
        ),
      );

      for (const doc of docs) {
        this.realtime.emitToRoom(
          `user:${doc.recipientId}`,
          'notification',
          doc,
        );
      }

      await this.push.sendToUsers(ids, {
        title: input.title,
        body: input.description,
        link: input.link,
        data: { type: input.type, referenceId: input.referenceId },
      });

      return { notified: ids.length };
    } catch (error) {
      this.logger.error(
        `Failed to notify (${input.type})`,
        error instanceof Error ? error.stack : error,
      );
      return { notified: 0 };
    }
  }

  /** A notification for the platform operators: the same table with `tenantId` and `recipientId` both null, broadcast to the `admin` Socket.IO room. Never throws, same invariant as `notify()`. */
  async notifySystem(
    content: NotificationContent & { referenceId?: string },
  ): Promise<void> {
    try {
      const notification = await this.prisma.notification.create({
        data: {
          tenantId: null,
          recipientId: null,
          type: content.type,
          title: content.title,
          description: content.description,
          link: content.link,
          referenceId: content.referenceId,
          isRead: false,
        },
      });
      this.realtime.emitToRoom('admin', 'system-notification', notification);
    } catch (error) {
      this.logger.error(
        `Failed to create system notification (${content.type})`,
        error instanceof Error ? error.stack : error,
      );
    }
  }

  async tenantOwners(tenantId: string): Promise<string[]> {
    try {
      const owners = await this.prisma.user.findMany({
        where: {
          tenantId,
          systemRole: SystemRole.TENANT_OWNER,
          status: UserStatus.ACTIVE,
        },
        select: { id: true },
      });
      return owners.map((o) => o.id);
    } catch (error) {
      this.logger.error(
        'tenantOwners lookup failed',
        error instanceof Error ? error.stack : error,
      );
      return [];
    }
  }

  /** Who to tell about something that happened at one branch or warehouse. The old BRANCH_MANAGER/WAREHOUSE_MANAGER roles are gone, so this reads the location's `managerId`, falling back to the tenant's owners - where the old version returned an empty list and sent a low-stock warning to nobody. */
  async managersOfLocation(args: {
    tenantId: string;
    branchId: string | null;
    warehouseId: string | null;
  }): Promise<string[]> {
    try {
      const location = args.branchId
        ? await this.prisma.branch.findFirst({
            where: { id: args.branchId, tenantId: args.tenantId },
            select: { managerId: true },
          })
        : args.warehouseId
          ? await this.prisma.warehouse.findFirst({
              where: { id: args.warehouseId, tenantId: args.tenantId },
              select: { managerId: true },
            })
          : null;

      if (!location?.managerId) return this.tenantOwners(args.tenantId);

      // An appointed manager who has since been suspended shouldn't be the only recipient.
      const manager = await this.prisma.user.findFirst({
        where: { id: location.managerId, status: UserStatus.ACTIVE },
        select: { id: true },
      });
      return manager ? [manager.id] : this.tenantOwners(args.tenantId);
    } catch (error) {
      this.logger.error(
        'managersOfLocation lookup failed',
        error instanceof Error ? error.stack : error,
      );
      return [];
    }
  }

  /** Who signs off on this person's requests: whoever is appointed manager of the location they work at, falling back to the owners. The requester is always removed, so a manager filing their own leave is never their own approver. */
  async approversOf(user: {
    userId: string;
    tenantId: string;
    branchId: string | null;
    warehouseId: string | null;
  }): Promise<string[]> {
    const managers = await this.managersOfLocation({
      tenantId: user.tenantId,
      branchId: user.branchId,
      warehouseId: user.warehouseId,
    });
    const others = managers.filter((id) => id !== user.userId);
    if (others.length > 0) return others;

    // They manage the place themselves (or it has no manager): escalate to the owners.
    const owners = await this.tenantOwners(user.tenantId);
    return owners.filter((id) => id !== user.userId);
  }

  /** A person's name for notification copy, falling back through email and phone to a generic word; never throws, since a vague name beats a failed transaction. */
  async displayName(userId: string): Promise<string> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          profileFirstName: true,
          profileLastName: true,
          email: true,
          phoneNumber: true,
        },
      });
      if (!user) return 'Nhân viên';

      const full =
        `${user.profileFirstName ?? ''} ${user.profileLastName ?? ''}`.trim();
      return full || user.email || user.phoneNumber || 'Nhân viên';
    } catch (error) {
      this.logger.error(
        'displayName lookup failed',
        error instanceof Error ? error.stack : error,
      );
      return 'Nhân viên';
    }
  }

  // ─── Inbox (ported from iKiotMS-BE's NotificationController) ───────────────

  private inboxFilter(user: AuthUser) {
    return {
      tenantId: user.tenantId,
      OR: [{ recipientId: user.userId }, { recipientId: null }],
    };
  }

  async listInbox(user: AuthUser, page: number, limit: number) {
    const where = this.inboxFilter(user);
    const [data, total, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({ where: { ...where, isRead: false } }),
    ]);
    return {
      data,
      unreadCount,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async unreadCount(user: AuthUser) {
    const count = await this.prisma.notification.count({
      where: { ...this.inboxFilter(user), isRead: false },
    });
    return { count };
  }

  async markAllRead(user: AuthUser) {
    await this.prisma.notification.updateMany({
      where: { ...this.inboxFilter(user), isRead: false },
      data: { isRead: true },
    });
    return { success: true };
  }

  async markRead(user: AuthUser, id: string) {
    const result = await this.prisma.notification.updateMany({
      where: { id, ...this.inboxFilter(user) },
      data: { isRead: true },
    });
    if (result.count === 0)
      throw new NotFoundException({
        code: ErrorCode.NOTIFICATION_NOT_FOUND,
        message: 'Notification not found',
      });
    return { success: true };
  }

  async deleteAll(user: AuthUser) {
    await this.prisma.notification.deleteMany({
      where: this.inboxFilter(user),
    });
    return { success: true };
  }

  async deleteOne(user: AuthUser, id: string) {
    const result = await this.prisma.notification.deleteMany({
      where: { id, ...this.inboxFilter(user) },
    });
    if (result.count === 0)
      throw new NotFoundException({
        code: ErrorCode.NOTIFICATION_NOT_FOUND,
        message: 'Notification not found',
      });
    return { success: true };
  }

  async registerDeviceToken(userId: string, token: string, userAgent?: string) {
    // Pull the token off every account that currently holds it first, so a token that migrated to a new login doesn't stay registered against the old one.
    await this.prisma.userFcmToken.deleteMany({ where: { token } });
    await this.prisma.userFcmToken.create({
      data: { userId, token, userAgent },
    });
    return { success: true };
  }

  async removeDeviceToken(userId: string, token: string) {
    await this.prisma.userFcmToken.deleteMany({ where: { userId, token } });
    return { success: true };
  }
}
