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

/** Every quota frozen onto a subscription at purchase time, derived from the schema rather than listed by hand, so a new `quotaSnapshot*` column is usable here immediately. */
export type QuotaField = Extract<keyof Subscription, `quotaSnapshot${string}`>;

/** Ported from SubscriptionService. Owns the state of a tenant's subscription - which plan, whether it is live, what it lets them do - while everything about getting paid lives in SubscriptionBillingService. */
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

  /** Returns the subscription with its status already brought up to date in the DB: the nightly cron sweeps in bulk, but a tenant must never be served on a term that ran out an hour ago. The rules themselves live in `nextSubscriptionStatus`. */
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
        // endDate equals trialEndDate for trials, so this is the right anchor whether the subscription expired as a trial or as a paid term.
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
   * The tenant's subscription as a billing screen needs to draw it - plan name, term,
   * and the quotas frozen at purchase - rather than the status summary `checkTrialStatus`
   * answers.
   *
   * iKiotMS-BE shipped this inside `GET /auth/me` (`AuthService.getMe` joined the
   * subscription for TENANT_OWNERs); the rewrite dropped it and nothing replaced it, so
   * the dashboard's "Gói hiện tại" card read `user.subscription` and got `undefined` on
   * every single request - it could only ever draw an empty plan, and no `fetchMe()` after
   * a payment could change that. It lives here and not back on `/auth/me` because one
   * screen wants it, `/auth/me` is fetched on every page load by every account kind, and a
   * screen that can refetch this on its own is a screen that updates when payment lands.
   *
   * Status is settled first, so a term that ran out overnight reads EXPIRED here even
   * before the nightly cron sweeps.
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
      // Named `currentQuotaSnapshot` because that is what the Mongo subdocument was called
      // and what the dashboard reads; the columns are flattened, the wire shape is not.
      currentQuotaSnapshot: {
        maxBranches: subscription.quotaSnapshotMaxBranches,
        maxWarehouses: subscription.quotaSnapshotMaxWarehouses,
        maxUsers: subscription.quotaSnapshotMaxUsers,
        maxProducts: subscription.quotaSnapshotMaxProducts,
      },
    };
  }

  /** iKiotMS-BE's `requireActiveSubscription` middleware as a service call, since callers need the row itself for its quota snapshot. PAST_DUE deliberately passes - that is what the grace period is for. */
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

  /** Shared quota gate for the limits frozen onto the subscription at purchase. A negative limit means unlimited and so does `null`, but `0` is a real limit of zero - it used to be lumped in with unlimited, turning "no branches" into "any number". `count` is a thunk so unlimited plans run no counting query. */
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

  /** Admin-only: change a tenant's plan directly, no payment involved. */
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

    // The same event the SePay webhook fires. Until this was here it was the *only*
    // emitter, so a plan switched by hand - the ordinary path in dev, where no webhook can
    // reach localhost - left every open dashboard showing the old plan until an F5.
    this.realtime.emitToRoom(`tenant:${tenantId}`, 'subscription:activated', {
      planId: updated.planId,
      status: updated.status,
      endDate: updated.endDate,
    });

    return { subscription: updated, oldPlan, newPlan };
  }
}

/** Freezes the plan's limits onto the subscription: quotas are snapshotted at purchase and never read live off the Plan, so a later price-list change can't shrink an existing customer. */
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
