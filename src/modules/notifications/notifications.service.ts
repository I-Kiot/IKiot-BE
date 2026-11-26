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

// Service thông báo: hộp thư, socket, push.
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
    private readonly push: PushService,
  ) {}

  // Gửi thông báo qua hộp thư, Socket.IO và FCM; không bao giờ ném lỗi.
  async notify(input: NotifyInput): Promise<{ notified: number }> {
    try {
      const ids = [
        ...new Set(
          input.recipientIds.filter((id): id is string => Boolean(id)),
        ),
      ];
      if (ids.length === 0) return { notified: 0 };

      // Mỗi người nhận một insert riêng.
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

  /** Thông báo hệ thống cho admin, không ném lỗi. */
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

  /** Người cần báo tại một địa điểm: quản lý, không có thì chủ shop. */
  async managersOfLocation(args: {
    tenantId: string;
    /** Id của Location, cũng là id của Branch hoặc Warehouse tương ứng. */
    locationId: string | null;
  }): Promise<string[]> {
    if (!args.locationId) return this.tenantOwners(args.tenantId);
    const byLocation = await this.managersOfLocations([
      { tenantId: args.tenantId, locationId: args.locationId },
    ]);
    return byLocation.get(args.locationId) ?? [];
  }

  /** Quản lý của nhiều địa điểm cùng lúc. */
  async managersOfLocations(
    pairs: { tenantId: string; locationId: string }[],
  ): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    if (pairs.length === 0) return result;
    try {
      const locations = await this.prisma.location.findMany({
        where: { id: { in: [...new Set(pairs.map((p) => p.locationId))] } },
        select: { id: true, tenantId: true, managerId: true },
      });
      const locationById = new Map(locations.map((l) => [l.id, l]));
      // Địa điểm phải thuộc đúng tenant được hỏi, như `findFirst({ id, tenantId })` của bản cũ.
      const managerIdOf = (pair: { tenantId: string; locationId: string }) => {
        const location = locationById.get(pair.locationId);
        return location?.tenantId === pair.tenantId ? location.managerId : null;
      };

      const managerIds = [
        ...new Set(pairs.map(managerIdOf).filter((id): id is string => !!id)),
      ];
      // Manager đã bị khóa không được là người nhận duy nhất.
      const activeManagers = new Set(
        managerIds.length === 0
          ? []
          : (
              await this.prisma.user.findMany({
                where: { id: { in: managerIds }, status: UserStatus.ACTIVE },
                select: { id: true },
              })
            ).map((u) => u.id),
      );

      const needOwners = [
        ...new Set(
          pairs
            .filter((p) => {
              const managerId = managerIdOf(p);
              return !managerId || !activeManagers.has(managerId);
            })
            .map((p) => p.tenantId),
        ),
      ];
      const ownersByTenant = new Map<string, string[]>();
      if (needOwners.length > 0) {
        const owners = await this.prisma.user.findMany({
          where: {
            tenantId: { in: needOwners },
            systemRole: SystemRole.TENANT_OWNER,
            status: UserStatus.ACTIVE,
          },
          select: { id: true, tenantId: true },
        });
        for (const owner of owners) {
          if (!owner.tenantId) continue;
          ownersByTenant.set(owner.tenantId, [
            ...(ownersByTenant.get(owner.tenantId) ?? []),
            owner.id,
          ]);
        }
      }

      for (const pair of pairs) {
        const managerId = managerIdOf(pair);
        result.set(
          pair.locationId,
          managerId && activeManagers.has(managerId)
            ? [managerId]
            : (ownersByTenant.get(pair.tenantId) ?? []),
        );
      }
      return result;
    } catch (error) {
      this.logger.error(
        'managersOfLocation lookup failed',
        error instanceof Error ? error.stack : error,
      );
      return new Map();
    }
  }

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
    // Gỡ token khỏi tài khoản cũ trước.
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
