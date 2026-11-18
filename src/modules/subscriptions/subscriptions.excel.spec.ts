import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { SubscriptionService } from './subscriptions.service';

const DAY = 24 * 60 * 60 * 1000;
const bodyOf = (error: unknown) =>
  (error as BadRequestException).getResponse() as {
    code: string;
    message: string;
  };

// Excel sheet "Subscriptions" - SubscriptionService (UTC011-UTC030).
describe('Excel sheet Subscriptions - SubscriptionService', () => {
  let prisma: any;
  let realtime: { emitToRoom: jest.Mock };
  let service: SubscriptionService;

  const sub = (over: Record<string, unknown> = {}) => ({
    id: 'S1',
    tenantId: 'T1',
    planId: 'PRO',
    status: 'ACTIVE',
    startDate: new Date(Date.now() - 10 * DAY),
    endDate: new Date(Date.now() + 20 * DAY),
    trialEndDate: null,
    autoRenew: true,
    quotaSnapshotMaxBranches: 3,
    plan: { planCode: 'PRO', planName: 'Pro', billingCycle: 'MONTHLY' },
    ...over,
  });

  beforeEach(() => {
    prisma = {
      subscription: {
        findFirst: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
      plan: { findFirst: jest.fn(), findUnique: jest.fn() },
    };
    realtime = { emitToRoom: jest.fn() };
    service = new SubscriptionService(prisma, realtime as never);
  });

  const has = (s: Record<string, unknown> | null) =>
    prisma.subscription.findFirst.mockResolvedValue(s);

  describe('requireActiveSubscription', () => {
    it('UTC011: no subscription', async () => {
      has(null);
      const run = service.requireActiveSubscription('T1');
      await expect(run).rejects.toThrow(ForbiddenException);
      await run.catch((error) => {
        expect(bodyOf(error).code).toBe('SUBSCRIPTION_MISSING');
        expect(bodyOf(error).message).toBe(
          'This shop has no subscription plan',
        );
      });
    });
    it('UTC012: EXPIRED subscription', async () => {
      has(sub({ status: 'EXPIRED' }));
      const run = service.requireActiveSubscription('T1');
      await expect(run).rejects.toThrow(ForbiddenException);
      await run.catch((error) => {
        expect(bodyOf(error).code).toBe('SUBSCRIPTION_EXPIRED');
        expect(bodyOf(error).message).toBe(
          'The subscription has expired. Please renew it to continue.',
        );
      });
    });
    it('UTC013: CANCELLED subscription', async () => {
      has(sub({ status: 'CANCELLED' }));
      const run = service.requireActiveSubscription('T1');
      await expect(run).rejects.toThrow(ForbiddenException);
      await run.catch((error) => {
        expect(bodyOf(error).code).toBe('SUBSCRIPTION_CANCELLED');
        expect(bodyOf(error).message).toBe(
          'The subscription was cancelled. Please subscribe again to continue.',
        );
      });
    });
    it('UTC014: a running TRIAL is allowed', async () => {
      has(
        sub({ status: 'TRIAL', trialEndDate: new Date(Date.now() + 5 * DAY) }),
      );
      await expect(service.requireActiveSubscription('T1')).resolves.toEqual(
        expect.objectContaining({ status: 'TRIAL' }),
      );
    });
    it('UTC015: an ACTIVE subscription is allowed', async () => {
      has(sub());
      await expect(service.requireActiveSubscription('T1')).resolves.toEqual(
        expect.objectContaining({ status: 'ACTIVE' }),
      );
    });
    it('UTC016: one day past the end date is PAST_DUE and still allowed', async () => {
      has(sub({ endDate: new Date(Date.now() - DAY) }));
      const res = await service.requireActiveSubscription('T1');
      expect(res.status).toBe('PAST_DUE');
      expect(prisma.subscription.update).toHaveBeenCalledWith({
        where: { id: 'S1' },
        data: { status: 'PAST_DUE' },
      });
    });
  });

  describe('assertQuota', () => {
    const quota = 'quotaSnapshotMaxBranches' as const;
    it('UTC017: an unlimited quota (-1) passes without counting', async () => {
      has(sub({ quotaSnapshotMaxBranches: -1 }));
      const count = jest.fn();
      await expect(
        service.assertQuota('T1', quota, count, 'branches'),
      ).resolves.toBeUndefined();
      expect(count).not.toHaveBeenCalled();
    });
    it('UTC018: below the limit passes', async () => {
      has(sub());
      await expect(
        service.assertQuota('T1', quota, () => Promise.resolve(2), 'branches'),
      ).resolves.toBeUndefined();
    });
    it('UTC019: reaching the limit is refused', async () => {
      has(sub());
      const run = service.assertQuota(
        'T1',
        quota,
        () => Promise.resolve(3),
        'branches',
      );
      await expect(run).rejects.toThrow(BadRequestException);
      await run.catch((error) => {
        expect(bodyOf(error).code).toBe('PLAN_QUOTA_EXCEEDED');
        expect(bodyOf(error).message).toBe(
          'The plan limit for branches has been reached (max 3, currently 3). Please upgrade.',
        );
      });
    });
    it('UTC020: above the limit is refused', async () => {
      has(sub());
      const run = service.assertQuota(
        'T1',
        quota,
        () => Promise.resolve(5),
        'branches',
      );
      await expect(run).rejects.toThrow(BadRequestException);
      await run.catch((error) => {
        expect(bodyOf(error).message).toContain('(max 3, currently 5)');
      });
    });
    it('UTC021: an expired subscription is refused before the quota is counted', async () => {
      has(sub({ status: 'EXPIRED' }));
      const count = jest.fn();
      const run = service.assertQuota('T1', quota, count, 'branches');
      await expect(run).rejects.toThrow(ForbiddenException);
      await run.catch((error) => {
        expect(bodyOf(error).code).toBe('SUBSCRIPTION_EXPIRED');
      });
      expect(count).not.toHaveBeenCalled();
    });
  });

  describe('checkTrialStatus', () => {
    it('UTC022: no subscription', async () => {
      has(null);
      await expect(service.checkTrialStatus('T1')).resolves.toEqual({
        status: 'NO_SUBSCRIPTION',
      });
    });
    it('UTC023: a trial with 10 days left', async () => {
      const trialEndDate = new Date(Date.now() + 10 * DAY);
      has(sub({ status: 'TRIAL', trialEndDate, endDate: trialEndDate }));
      await expect(service.checkTrialStatus('T1')).resolves.toEqual({
        status: 'TRIAL',
        daysLeft: 10,
        trialEndDate,
      });
    });
    it('UTC024: an active subscription with 20 days left', async () => {
      const endDate = new Date(Date.now() + 20 * DAY);
      has(sub({ endDate }));
      await expect(service.checkTrialStatus('T1')).resolves.toEqual({
        status: 'ACTIVE',
        daysLeft: 20,
        endDate,
        planCode: 'PRO',
      });
    });
    it('UTC025: two days past the end date is PAST_DUE with the grace deadline', async () => {
      const endDate = new Date(Date.now() - 2 * DAY);
      has(sub({ endDate }));
      await expect(service.checkTrialStatus('T1')).resolves.toEqual({
        status: 'PAST_DUE',
        daysOverdue: 2,
        gracePeriodEndsAt: new Date(endDate.getTime() + 3 * DAY),
        endDate,
        planCode: 'PRO',
      });
    });
    it('UTC026: five days past the end date is EXPIRED', async () => {
      has(sub({ endDate: new Date(Date.now() - 5 * DAY) }));
      await expect(service.checkTrialStatus('T1')).resolves.toEqual({
        status: 'EXPIRED',
        daysOverdue: 5,
      });
    });
  });

  describe('adminUpgradePlan', () => {
    const newPlan = {
      id: 'PRO',
      planCode: 'PRO',
      billingCycle: 'MONTHLY',
      maxBranches: 5,
      maxWarehouses: 5,
      maxUsers: 20,
      maxProducts: 1000,
    };
    it('UTC027: upgrades, resets the term and notifies the tenant', async () => {
      prisma.subscription.findFirst.mockResolvedValue({
        id: 'S1',
        planId: 'TRIAL',
      });
      prisma.plan.findFirst.mockResolvedValue(newPlan);
      prisma.plan.findUnique.mockResolvedValue({
        id: 'TRIAL',
        planCode: 'TRIAL',
      });
      prisma.subscription.update.mockImplementation(({ data }) =>
        Promise.resolve({
          planId: data.planId,
          status: data.status,
          endDate: data.endDate,
        }),
      );
      const res = await service.adminUpgradePlan('T1', 'ADMIN1', 'PRO');
      const { data } = prisma.subscription.update.mock.calls[0][0];
      expect(data).toEqual(
        expect.objectContaining({
          planId: 'PRO',
          status: 'ACTIVE',
          trialEndDate: null,
          quotaSnapshotMaxBranches: 5,
        }),
      );
      expect(data.endDate.getTime() - data.startDate.getTime()).toBe(30 * DAY);
      expect(data.historyLogs.create).toEqual(
        expect.objectContaining({
          event: 'UPGRADED',
          fromPlanId: 'TRIAL',
          toPlanId: 'PRO',
          changedById: 'ADMIN1',
          note: 'Upgraded from TRIAL to PRO',
        }),
      );
      expect(realtime.emitToRoom).toHaveBeenCalledWith(
        'tenant:T1',
        'subscription:activated',
        expect.objectContaining({ planId: 'PRO', status: 'ACTIVE' }),
      );
      expect(res.newPlan.planCode).toBe('PRO');
    });
    it('UTC028: a tenant without a subscription', async () => {
      prisma.subscription.findFirst.mockResolvedValue(null);
      const run = service.adminUpgradePlan('T1', 'ADMIN1', 'PRO');
      await expect(run).rejects.toThrow(BadRequestException);
      await run.catch((error) => {
        expect(bodyOf(error).code).toBe('SUBSCRIPTION_NOT_FOUND');
        expect(bodyOf(error).message).toBe('No active subscription found');
      });
    });
    it('UTC029: an unknown plan code', async () => {
      prisma.subscription.findFirst.mockResolvedValue({
        id: 'S1',
        planId: 'TRIAL',
      });
      prisma.plan.findFirst.mockResolvedValue(null);
      const run = service.adminUpgradePlan('T1', 'ADMIN1', 'NOPE');
      await expect(run).rejects.toThrow(BadRequestException);
      await run.catch((error) => {
        expect(bodyOf(error).code).toBe('PLAN_NOT_FOUND');
        expect(bodyOf(error).message).toBe('Plan NOPE not found or inactive');
      });
    });
    it('UTC030: an inactive plan is looked up with isActive and refused', async () => {
      prisma.subscription.findFirst.mockResolvedValue({
        id: 'S1',
        planId: 'TRIAL',
      });
      prisma.plan.findFirst.mockResolvedValue(null);
      await service
        .adminUpgradePlan('T1', 'ADMIN1', 'PRO')
        .catch(() => undefined);
      expect(prisma.plan.findFirst).toHaveBeenCalledWith({
        where: { planCode: 'PRO', isActive: true },
      });
      expect(prisma.subscription.update).not.toHaveBeenCalled();
    });
  });
});
