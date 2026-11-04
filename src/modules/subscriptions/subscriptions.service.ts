import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  addDays,
  getBillingDays,
  GRACE_PERIOD_DAYS,
  wholeDaysBetween,
} from './subscription.constants';
import {
  nextSubscriptionStatus,
  SubscriptionStatus,
} from './subscription-status';
import type { Plan, Subscription } from '../../../generated/prisma/client';
import { ErrorCode } from '../../common/errors/error-codes';
import { RealtimeGateway } from '../../common/realtime/realtime.gateway';

/** Mọi quota đóng băng vào gói lúc mua, lấy từ schema chứ không liệt kê tay, nên cột `quotaSnapshot*` mới dùng được ngay ở đây. */
export type QuotaField = Extract<keyof Subscription, `quotaSnapshot${string}`>;

/** Port từ SubscriptionService. Quản lý trạng thái gói của tenant (gói nào, còn hiệu lực không, được làm gì); phần thu tiền nằm ở SubscriptionBillingService. */
@Injectable()
export class SubscriptionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
  ) {}

  async assignFreeTrial(tenantId: string, userId: string) {
    const existing = await this.prisma.subscription.findFirst({
      where: { tenantId },
    });
    if (existing)
      throw new BadRequestException({
        code: ErrorCode.SUBSCRIPTION_ALREADY_EXISTS,
        message: 'Tenant already has a subscription',
      });

    const plan = await this.prisma.plan.findFirst({
      where: { planCode: 'TRIAL', isActive: true },
    });
    if (!plan)
      throw new BadRequestException({
        code: ErrorCode.TRIAL_PLAN_UNAVAILABLE,
        message: 'Free trial plan not available',
      });

    const startDate = new Date();
    const trialEndDate = addDays(startDate, plan.trialDays);

    const subscription = await this.prisma.subscription.create({
      data: {
        tenantId,
        planId: plan.id,
        status: SubscriptionStatus.TRIAL,
        startDate,
        endDate: new Date(trialEndDate),
        trialEndDate,
        autoRenew: true,
        ...quotaSnapshotOf(plan),
        historyLogs: {
          create: {
            event: 'CREATED',
            toPlanId: plan.id,
            changedAt: startDate,
            changedById: userId,
            note: 'Free trial assigned to existing account',
          },
        },
      },
    });

    return {
      subscription: {
        id: subscription.id,
        status: subscription.status,
        trialEndDate: subscription.trialEndDate,
      },
      plan: {
        id: plan.id,
        planName: plan.planName,
        planCode: plan.planCode,
        trialDays: plan.trialDays,
      },
    };
  }

  /** Trả về gói với trạng thái đã cập nhật trong DB: cron ban đêm quét theo lô, nhưng tenant không được phục vụ bằng kỳ đã hết từ một giờ trước. Quy tắc nằm ở `nextSubscriptionStatus`. */
  private async settleSubscription(
    tenantId: string,
  ): Promise<(Subscription & { plan: Plan | null }) | null> {
    const subscription = await this.prisma.subscription.findFirst({
      where: { tenantId },
      include: { plan: true },
    });
    if (!subscription) return null;

    const status = nextSubscriptionStatus(subscription, new Date());
    if (status !== subscription.status) {
      await this.prisma.subscription.update({
        where: { id: subscription.id },
        data: { status },
      });
      subscription.status = status;
    }
    return subscription;
  }

  async checkTrialStatus(tenantId: string) {
    const subscription = await this.settleSubscription(tenantId);
    if (!subscription) return { status: 'NO_SUBSCRIPTION' as const };

    const now = new Date();
    const { endDate, trialEndDate, plan } = subscription;

    switch (subscription.status) {
      case SubscriptionStatus.TRIAL:
        return {
          status: SubscriptionStatus.TRIAL,
          daysLeft: trialEndDate ? wholeDaysBetween(now, trialEndDate) : null,
          trialEndDate,
        };
      case SubscriptionStatus.EXPIRED:
        // endDate của trial bằng trialEndDate, nên dùng làm mốc đúng cả khi gói hết hạn dạng trial lẫn kỳ trả phí.
        return {
          status: SubscriptionStatus.EXPIRED,
          daysOverdue: wholeDaysBetween(endDate, now),
        };
      case SubscriptionStatus.PAST_DUE:
        return {
          status: SubscriptionStatus.PAST_DUE,
          daysOverdue: wholeDaysBetween(endDate, now),
          gracePeriodEndsAt: addDays(endDate, GRACE_PERIOD_DAYS),
          endDate,
          planCode: plan?.planCode,
        };
      case SubscriptionStatus.ACTIVE:
        return {
          status: SubscriptionStatus.ACTIVE,
          daysLeft: wholeDaysBetween(now, endDate),
          endDate,
          planCode: plan?.planCode,
        };
      default:
        return { status: subscription.status };
    }
  }

  /**
   * Gói của tenant để màn billing vẽ: tên gói, kỳ hạn và quota đóng băng lúc mua (khác với tóm tắt của `checkTrialStatus`).
   * Không nằm trên `/auth/me` vì route đó được gọi ở mọi lần tải trang; màn này tự refetch được khi thanh toán xong.
   * Bản NestJS đầu từng bỏ field này khiến thẻ "Gói hiện tại" luôn trống.
   * Trạng thái được cập nhật trước, nên kỳ đã hết qua đêm hiện EXPIRED ngay, không chờ cron.
   */
  async getCurrentSubscription(tenantId: string) {
    const subscription = await this.settleSubscription(tenantId);
    if (!subscription) return null;

    return {
      id: subscription.id,
      planId: subscription.planId,
      planName: subscription.plan?.planName ?? '',
      planCode: subscription.plan?.planCode ?? '',
      billingCycle: subscription.plan?.billingCycle ?? null,
      status: subscription.status,
      startDate: subscription.startDate,
      endDate: subscription.endDate,
      trialEndDate: subscription.trialEndDate,
      autoRenew: subscription.autoRenew,
      // Tên `currentQuotaSnapshot` giữ theo subdocument Mongo cũ và dashboard; cột được gom phẳng, còn dạng trả về thì không.
      currentQuotaSnapshot: {
        maxBranches: subscription.quotaSnapshotMaxBranches,
        maxWarehouses: subscription.quotaSnapshotMaxWarehouses,
        maxUsers: subscription.quotaSnapshotMaxUsers,
        maxProducts: subscription.quotaSnapshotMaxProducts,
      },
    };
  }

  /** Bản service của middleware `requireActiveSubscription` cũ: caller cần chính row để lấy quota snapshot. PAST_DUE cố ý cho qua, đó là mục đích của thời gian ân hạn. */
  async requireActiveSubscription(
    tenantId: string,
  ): Promise<Subscription & { plan: Plan | null }> {
    const subscription = await this.settleSubscription(tenantId);
    if (!subscription) {
      throw new ForbiddenException({
        code: ErrorCode.SUBSCRIPTION_MISSING,
        message: 'This shop has no subscription plan',
      });
    }
    if (subscription.status === SubscriptionStatus.EXPIRED) {
      throw new ForbiddenException({
        code: ErrorCode.SUBSCRIPTION_EXPIRED,
        message: 'The subscription has expired. Please renew it to continue.',
      });
    }
    if (subscription.status === SubscriptionStatus.CANCELLED) {
      throw new ForbiddenException({
        code: ErrorCode.SUBSCRIPTION_CANCELLED,
        message:
          'The subscription was cancelled. Please subscribe again to continue.',
      });
    }
    return subscription;
  }

  /** Cổng kiểm hạn mức dùng chung, theo các giới hạn đóng băng trên gói lúc mua. Số âm hoặc `null` là không giới hạn; `0` là giới hạn thật bằng không (trước đây bị gộp với không giới hạn, khiến "không có chi nhánh" thành "bao nhiêu cũng được"). `count` là hàm để gói không giới hạn không chạy query đếm. */
  async assertQuota(
    tenantId: string,
    quota: QuotaField,
    count: () => Promise<number>,
    label: string,
  ): Promise<void> {
    const subscription = await this.requireActiveSubscription(tenantId);
    const max = subscription[quota];
    if (max === null || max < 0) return;

    const current = await count();
    if (current >= max) {
      throw new BadRequestException({
        code: ErrorCode.PLAN_QUOTA_EXCEEDED,
        message: `The plan limit for ${label} has been reached (max ${max}, currently ${current}). Please upgrade.`,
      });
    }
  }

  /** Chỉ admin: đổi gói của tenant trực tiếp, không qua thanh toán. */
  async adminUpgradePlan(
    tenantId: string,
    adminUserId: string,
    newPlanCode: string,
  ) {
    const currentSubscription = await this.prisma.subscription.findFirst({
      where: { tenantId },
    });
    if (!currentSubscription)
      throw new BadRequestException({
        code: ErrorCode.SUBSCRIPTION_NOT_FOUND,
        message: 'No active subscription found',
      });

    const newPlan = await this.prisma.plan.findFirst({
      where: { planCode: newPlanCode, isActive: true },
    });
    if (!newPlan)
      throw new BadRequestException({
        code: ErrorCode.PLAN_NOT_FOUND,
        message: `Plan ${newPlanCode} not found or inactive`,
      });

    const oldPlan = currentSubscription.planId
      ? await this.prisma.plan.findUnique({
          where: { id: currentSubscription.planId },
        })
      : null;

    const now = new Date();
    const updated = await this.prisma.subscription.update({
      where: { id: currentSubscription.id },
      data: {
        planId: newPlan.id,
        status: SubscriptionStatus.ACTIVE,
        startDate: now,
        endDate: addDays(now, getBillingDays(newPlan.billingCycle)),
        trialEndDate: null,
        ...quotaSnapshotOf(newPlan),
        historyLogs: {
          create: {
            event: 'UPGRADED',
            fromPlanId: currentSubscription.planId,
            toPlanId: newPlan.id,
            changedAt: now,
            changedById: adminUserId,
            note: `Upgraded from ${oldPlan?.planCode ?? 'unknown'} to ${newPlanCode}`,
          },
        },
      },
    });

    // Cùng sự kiện mà webhook SePay phát ra. Trước đó đây là nơi phát duy nhất, nên gói đổi tay (đường thường gặp khi dev, vì webhook không tới được localhost) khiến dashboard đang mở vẫn hiện gói cũ cho tới khi F5.
    this.realtime.emitToRoom(`tenant:${tenantId}`, 'subscription:activated', {
      planId: updated.planId,
      status: updated.status,
      endDate: updated.endDate,
    });

    return { subscription: updated, oldPlan, newPlan };
  }
}

/** Đóng băng hạn mức của gói vào subscription: quota chốt lúc mua, không đọc lại từ Plan, nên đổi bảng giá về sau không làm giảm quyền của khách đang có gói. */
export function quotaSnapshotOf(
  plan: Pick<
    Plan,
    'maxBranches' | 'maxWarehouses' | 'maxUsers' | 'maxProducts'
  >,
): Pick<Subscription, QuotaField> {
  return {
    quotaSnapshotMaxBranches: plan.maxBranches,
    quotaSnapshotMaxWarehouses: plan.maxWarehouses,
    quotaSnapshotMaxUsers: plan.maxUsers,
    quotaSnapshotMaxProducts: plan.maxProducts,
  };
}
