import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailService } from '../../common/email/email.service';
import { SystemRole } from '../../common/constants/system-role';
import { UserStatus } from '../../common/constants/user-status';
import { paginate, skipFor } from '../../common/utils/pagination';
import {
  ANNOUNCEMENT_TYPE,
  AnnouncementTarget,
  SYSTEM_NOTIFICATION_TYPES,
} from './system-notification.constants';
import type {
  ComposeAnnouncementDto,
  ListSystemNotificationsDto,
} from './dto/announcement.dto';
import { ErrorCode } from '../../common/errors/error-codes';

/** Console thông báo của operator. Đọc cùng bảng `notifications` với inbox shop, phân biệt bằng `tenantId` và `recipientId` đều null. `notifySystem()` là nơi duy nhất ghi feed này; announcement có type riêng, không bao giờ vào feed. */
@Injectable()
export class AdminNotificationService {
  private readonly logger = new Logger(AdminNotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
  ) {}

  async listSystem(query: ListSystemNotificationsDto) {
    const { page, limit } = query;
    const where = this.systemFilter();

    const [rows, total] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: skipFor(page, limit),
        take: limit,
      }),
      this.prisma.notification.count({ where }),
    ]);

    return paginate(rows, total, page, limit);
  }

  /** Bản JS cũ là handler duy nhất trong 5 cái thiếu filter, nên operator có thể đổi cờ đọc của mọi thông báo trong DB và đọc nội dung qua response. Filter này chặn việc đó. */
  async markSystemRead(id: string) {
    const { count } = await this.prisma.notification.updateMany({
      where: { id, ...this.systemFilter() },
      data: { isRead: true },
    });
    if (count === 0)
      throw new NotFoundException({
        code: ErrorCode.NOTIFICATION_NOT_FOUND,
        message: 'Notification not found',
      });
    return this.prisma.notification.findUnique({ where: { id } });
  }

  async markAllSystemRead() {
    const { count } = await this.prisma.notification.updateMany({
      where: { ...this.systemFilter(), isRead: false },
      data: { isRead: true },
    });
    return { message: 'Đã đánh dấu tất cả là đã đọc', updated: count };
  }

  async removeSystem(id: string) {
    const { count } = await this.prisma.notification.deleteMany({
      where: { id, ...this.systemFilter() },
    });
    if (count === 0)
      throw new NotFoundException({
        code: ErrorCode.NOTIFICATION_NOT_FOUND,
        message: 'Notification not found',
      });
    return { message: 'Đã xoá thông báo' };
  }

  async removeAllSystem() {
    const { count } = await this.prisma.notification.deleteMany({
      where: this.systemFilter(),
    });
    return { message: 'Đã xoá toàn bộ thông báo hệ thống', deleted: count };
  }

  /** Gửi email tới nhiều chủ shop và lưu bản ghi. Gửi không chờ (fire-and-forget); row ghi trước để còn bản ghi khi gửi lỗi. `recipients` đếm chủ có email, không phải số shop được nhắm. */
  async compose(actorId: string, dto: ComposeAnnouncementDto) {
    const isSelection = dto.targetType === AnnouncementTarget.SELECTION;
    const targetTenants = isSelection ? (dto.targetTenants ?? []) : [];

    const announcement = await this.prisma.notification.create({
      data: {
        title: dto.title,
        description: dto.description,
        type: ANNOUNCEMENT_TYPE,
        category: dto.category,
        targetType: dto.targetType,
        createdById: actorId,
        isRead: false,
        targetTenants: {
          create: targetTenants.map((tenantId) => ({ tenantId })),
        },
      },
      include: {
        targetTenants: { include: { tenant: { select: { name: true } } } },
      },
    });

    const owners = await this.prisma.user.findMany({
      where: {
        systemRole: SystemRole.TENANT_OWNER,
        status: UserStatus.ACTIVE,
        email: { not: null },
        ...(isSelection ? { tenantId: { in: targetTenants } } : {}),
      },
      select: { email: true },
    });
    const recipients = owners
      .map((owner) => owner.email)
      .filter((email): email is string => Boolean(email));

    for (const to of recipients) {
      void this.email
        .sendSystemNotificationEmail(to, {
          title: dto.title,
          description: dto.description,
          category: dto.category,
        })
        .catch((error: unknown) => {
          this.logger.error(
            `Failed to send announcement email to ${to}`,
            error instanceof Error ? error.stack : error,
          );
        });
    }

    return {
      message: `Thông báo đã được xếp lịch gửi tới ${recipients.length} chủ cửa hàng.`,
      data: announcement,
    };
  }

  async listAnnouncements(query: ListSystemNotificationsDto) {
    const { page, limit } = query;
    const where = { type: ANNOUNCEMENT_TYPE };

    const [rows, total] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: skipFor(page, limit),
        take: limit,
        include: {
          targetTenants: { include: { tenant: { select: { name: true } } } },
          createdBy: {
            select: {
              email: true,
              profileFirstName: true,
              profileLastName: true,
            },
          },
        },
      }),
      this.prisma.notification.count({ where }),
    ]);

    return paginate(rows, total, page, limit);
  }

  private systemFilter() {
    return {
      tenantId: null,
      recipientId: null,
      type: { in: SYSTEM_NOTIFICATION_TYPES },
    };
  }
}
