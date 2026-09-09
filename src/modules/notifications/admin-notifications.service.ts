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

/** The platform operators' own notification console. It reads the same `notifications` table as every shop's inbox, separated by `tenantId` and `recipientId` both being null; `notifySystem()` is the only writer, so this is the read/acknowledge half. Its one write is an announcement, which is stored with its own type and never appears in the feed. */
@Injectable()
export class AdminNotificationService {
  private readonly logger = new Logger(AdminNotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
  ) {}

  // ─── System event feed ─────────────────────────────────────────────────────

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

  /** The old handler had no filter at all - the only one of the five that forgot it - so an operator could flip the read flag on any notification in the database and read its contents back out of the response. */
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

  // ─── Announcements ─────────────────────────────────────────────────────────

  /** Compose one email to many shop owners and keep a record that it was sent. The send is fire-and-forget, and the row is written first so the record survives a failed delivery; the count is owners with an email on file, not shops targeted. */
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

  /** What has been sent, newest first - the operators' own outbox. */
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

  /** What makes a row belong to the operators' console: nobody's tenant, nobody's inbox, and one of this feed's event types. */
  private systemFilter() {
    return {
      tenantId: null,
      recipientId: null,
      type: { in: SYSTEM_NOTIFICATION_TYPES },
    };
  }
}
