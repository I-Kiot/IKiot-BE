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

// Port từ notificationService.js (fan-out) và module notification (inbox API) của iKiotMS-BE, gộp vào đây. Nội dung thông báo mới đặt trong `templates/*.templates.ts`, không viết inline.
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
    private readonly push: PushService,
  ) {}

  // Không bao giờ throw: lỗi thông báo không được làm hỏng transaction đã gọi. Ba kênh: row Notification (inbox, badge), Socket.IO cho tab đang mở, FCM cho tab đã đóng. Push được await: notify() chạy sau commit nên chỉ làm chậm response, không giữ lock.
  async notify(input: NotifyInput): Promise<{ notified: number }> {
    try {
      const ids = [
        ...new Set(
          input.recipientIds.filter((id): id is string => Boolean(id)),
        ),
      ];
      if (ids.length === 0) return { notified: 0 };

      // Insert độc lập, cố ý không dùng transaction: một người nhận lỗi không rollback thông báo của những người khác.
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

  /** Thông báo cho operator: cùng bảng, `tenantId` và `recipientId` đều null, phát tới room Socket.IO `admin`. Không throw, như `notify()`. */
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

  /** Người cần báo khi có sự kiện tại một location. Vai trò BRANCH_MANAGER/WAREHOUSE_MANAGER cũ đã bỏ, nên đọc `managerId` của location, không có thì fallback về chủ tenant. Bản cũ trả về rỗng nên cảnh báo tồn thấp không ai nhận. */
  async managersOfLocation(args: {
    tenantId: string;
    /** Id của Location, cũng là id của Branch hoặc Warehouse tương ứng. */
    locationId: string | null;
  }): Promise<string[]> {
    try {
      const location = args.locationId
        ? await this.prisma.location.findFirst({
            where: { id: args.locationId, tenantId: args.tenantId },
            select: { managerId: true },
          })
        : null;

      if (!location?.managerId) return this.tenantOwners(args.tenantId);

      // Manager đã bị khóa không được là người nhận duy nhất.
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
    // Gỡ token khỏi mọi tài khoản đang giữ nó trước, để token đã chuyển sang login mới không còn đăng ký với login cũ.
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
