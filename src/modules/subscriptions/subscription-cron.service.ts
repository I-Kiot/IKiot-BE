import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationService } from '../notifications/notifications.service';
import { SubscriptionNotificationTemplates } from '../notifications/templates/subscription.templates';
import type { NotificationContent } from '../notifications/notification-content.type';
import { EmailService } from '../../common/email/email.service';
import { SystemRole } from '../../common/constants/system-role';
import { UserStatus } from '../../common/constants/user-status';
import { VIETNAM_TIMEZONE } from '../../common/constants/timezone';
import {
  addDays,
  REMINDER_DAYS,
  startOfDayUTC,
} from './subscription.constants';
import {
  nextSubscriptionStatus,
  SubscriptionStatus,
} from './subscription-status';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Các trạng thái mà đồng hồ vẫn có thể chuyển; EXPIRED và CANCELLED không tự đổi. */
const TRANSITIONABLE = [
  SubscriptionStatus.TRIAL,
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.PAST_DUE,
];

// Port từ subscriptionJob.js dùng @nestjs/schedule: cùng lịch 02:00 hằng ngày, cùng hai bước (đổi trạng thái rồi nhắc hết hạn), bỏ qua khi chạy test.
@Injectable()
export class SubscriptionCronService {
  private readonly logger = new Logger(SubscriptionCronService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
    private readonly email: EmailService,
  ) {}

  // 02:00 theo giờ Việt Nam, không theo giờ của host: mọi câu hỏi bên dưới đều về ngày lịch địa phương. Trên host UTC, 2 giờ sáng không gắn múi giờ sẽ chạy lúc 9 giờ sáng giờ VN và lệch một ngày.
  @Cron(CronExpression.EVERY_DAY_AT_2AM, { timeZone: VIETNAM_TIMEZONE })
  async runDailyJob() {
    if (process.env.NODE_ENV === 'test') return;

    this.logger.log('Running daily subscription check...');
    try {
      await this.runSubscriptionStatusCheck();
      await this.sendExpiryReminders();
    } catch (error) {
      this.logger.error(
        'Unhandled error in daily subscription job',
        error instanceof Error ? error.stack : error,
      );
    }
  }

  /** Quét hằng đêm mọi gói đã hết hạn. Quyết định lấy từ `nextSubscriptionStatus` (cùng hàm được áp dụng lười khi đọc); job này chỉ tìm ứng viên và ghi kết quả. */
  async runSubscriptionStatusCheck() {
    const now = new Date();

    // Gói đã xử lý xong bị bộ lọc ngày loại ra, nên tập này vẫn nhỏ kể cả với instance lớn.
    const candidates = await this.prisma.subscription.findMany({
      where: {
        status: { in: TRANSITIONABLE },
        OR: [{ endDate: { lt: now } }, { trialEndDate: { lt: now } }],
      },
      select: {
        id: true,
        tenantId: true,
        status: true,
        endDate: true,
        trialEndDate: true,
      },
    });

    const transitions = candidates
      .map((subscription) => ({
        subscription,
        nextStatus: nextSubscriptionStatus(subscription, now),
      }))
      .filter(
        ({ subscription, nextStatus }) => nextStatus !== subscription.status,
      );

    const byNextStatus = new Map<string, string[]>();
    for (const { subscription, nextStatus } of transitions) {
      const ids = byNextStatus.get(nextStatus) ?? [];
      ids.push(subscription.id);
      byNextStatus.set(nextStatus, ids);
    }

    for (const [status, ids] of byNextStatus) {
      await this.prisma.subscription.updateMany({
        where: { id: { in: ids } },
        data: { status },
      });
      this.logger.log(`Moved ${ids.length} subscription(s) to ${status}`);
    }

    // Hết dùng thử và hết kỳ trả phí được chủ shop hiểu rất khác nhau, nên có nội dung riêng dù cả hai đều thành EXPIRED.
    const expired = transitions.filter(
      ({ nextStatus }) => nextStatus === SubscriptionStatus.EXPIRED,
    );
    await this.notifyStatusChange(
      expired
        .filter(
          ({ subscription }) =>
            subscription.status === SubscriptionStatus.TRIAL,
        )
        .map(({ subscription }) => subscription),
      SubscriptionNotificationTemplates.trialExpired(),
    );
    await this.notifyStatusChange(
      expired
        .filter(
          ({ subscription }) =>
            subscription.status !== SubscriptionStatus.TRIAL,
        )
        .map(({ subscription }) => subscription),
      SubscriptionNotificationTemplates.expired(),
    );
  }

  async sendExpiryReminders() {
    const today = startOfDayUTC(new Date());

    for (const days of REMINDER_DAYS) {
      const windowStart = addDays(today, days);
      const windowEnd = new Date(windowStart.getTime() + DAY_MS);

      const subscriptions = await this.prisma.subscription.findMany({
        where: {
          status: {
            in: [SubscriptionStatus.TRIAL, SubscriptionStatus.ACTIVE],
          },
          endDate: { gte: windowStart, lt: windowEnd },
        },
        include: {
          plan: { select: { planName: true } },
          tenant: { select: { name: true } },
        },
      });
      if (subscriptions.length === 0) continue;

      const ownerByTenant = await this.ownersOf(
        subscriptions.map((subscription) => subscription.tenantId),
      );

      for (const sub of subscriptions) {
        const owner = ownerByTenant.get(sub.tenantId);

        await this.notifications.notify({
          tenantId: sub.tenantId,
          recipientIds: [owner?.id],
          referenceId: sub.id,
          ...SubscriptionNotificationTemplates.expiring(
            days,
            sub.plan?.planName ?? 'dịch vụ',
          ),
        });

        if (!owner?.email) continue;
        await this.email.sendSubscriptionReminder(owner.email, {
          tenantName: sub.tenant?.name ?? 'Quý khách',
          planName: sub.plan?.planName ?? 'Gói dịch vụ',
          daysLeft: days,
          endDate: sub.endDate,
        });
      }
    }
  }

  /** Owner của từng tenant, lấy trong một query cho cả batch. `Tenant.tenantOwnerId` là scalar không ràng buộc FK (relation sẽ thành FK vòng lúc tạo), nên tìm owner theo role. */
  private async ownersOf(tenantIds: string[]) {
    const owners = await this.prisma.user.findMany({
      where: {
        tenantId: { in: tenantIds },
        systemRole: SystemRole.TENANT_OWNER,
        status: UserStatus.ACTIVE,
      },
      select: { id: true, email: true, tenantId: true },
    });

    const byTenant = new Map<string, { id: string; email: string | null }>();
    for (const owner of owners) {
      if (owner.tenantId && !byTenant.has(owner.tenantId)) {
        byTenant.set(owner.tenantId, { id: owner.id, email: owner.email });
      }
    }
    return byTenant;
  }

  private async notifyStatusChange(
    subscriptions: { id: string; tenantId: string }[],
    content: NotificationContent,
  ) {
    for (const sub of subscriptions) {
      const owners = await this.notifications.tenantOwners(sub.tenantId);
      await this.notifications.notify({
        tenantId: sub.tenantId,
        recipientIds: owners,
        referenceId: sub.id,
        ...content,
      });
    }
  }
}
