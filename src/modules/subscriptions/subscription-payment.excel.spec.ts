import {
  BadRequestException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { SepaySubscriptionService } from './sepay-subscription.service';
import { SubscriptionBillingService } from './subscription-billing.service';
import { SubscriptionService } from './subscriptions.service';

const DAY = 24 * 60 * 60 * 1000;
const bodyOf = (error: unknown) =>
  (error as BadRequestException).getResponse() as {
    code: string;
    message: string;
  };

// Sheet Excel "Subscriptions" - SepaySubscriptionService (UTC031-UTC040).
describe('Excel sheet Subscriptions - SepaySubscriptionService', () => {
  const service = new SepaySubscriptionService();
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('UTC031: references start with IKMS followed by hex and are unique', () => {
    const a = service.generatePaymentReference();
    expect(a).toMatch(/^IKMS[0-9A-F]{10}$/);
    expect(a).not.toBe(service.generatePaymentReference());
  });

  it('UTC032: the QR link uses the platform bank account from the environment', () => {
    process.env.SEPAY_ACCOUNT_NUMBER = '999';
    process.env.SEPAY_BANK_NAME = 'VCB';
    process.env.SEPAY_ACCOUNT_NAME = 'IKIOT CO';
    expect(service.buildQrUrl(500000, 'IKMS1A2B3C4D5E')).toBe(
      'https://img.vietqr.io/image/VCB-999-compact2.png?amount=500000&addInfo=IKMS1A2B3C4D5E&accountName=IKIOT%20CO',
    );
  });

  it('UTC033: missing SEPAY_* variables give empty segments without throwing', () => {
    delete process.env.SEPAY_ACCOUNT_NUMBER;
    delete process.env.SEPAY_BANK_NAME;
    delete process.env.SEPAY_ACCOUNT_NAME;
    expect(service.buildQrUrl(500000, 'IKMS1A2B3C4D5E')).toBe(
      'https://img.vietqr.io/image/--compact2.png?amount=500000&addInfo=IKMS1A2B3C4D5E&accountName=',
    );
  });

  describe('verifyWebhookKey', () => {
    it('UTC034: the configured key matches', () => {
      process.env.SEPAY_WEBHOOK_API_KEY = 'secret';
      expect(service.verifyWebhookKey('secret')).toBe(true);
    });
    it('UTC035: a different key is refused', () => {
      process.env.SEPAY_WEBHOOK_API_KEY = 'secret';
      expect(service.verifyWebhookKey('other')).toBe(false);
    });
    it('UTC036: an empty key is refused when one is configured', () => {
      process.env.SEPAY_WEBHOOK_API_KEY = 'secret';
      expect(service.verifyWebhookKey('')).toBe(false);
    });
    it('UTC037: an unset configured key never matches, even an empty one', () => {
      delete process.env.SEPAY_WEBHOOK_API_KEY;
      expect(service.verifyWebhookKey('')).toBe(false);
    });
  });

  describe('extractReference', () => {
    it('UTC038: finds the reference inside free text', () => {
      expect(service.extractReference('Thanh toan IKMS1A2B3C4D5E')).toBe(
        'IKMS1A2B3C4D5E',
      );
    });
    it('UTC039: is case-insensitive and accepts the 6-hex legacy format', () => {
      expect(service.extractReference('ikms1a2b3c')).toBe('IKMS1A2B3C');
    });
    it.each([['ORD1A2B3C4D5E'], [''], [undefined]])(
      'UTC040: no IKMS reference in %p gives null',
      (content) => {
        expect(service.extractReference(content)).toBeNull();
      },
    );
  });
});

// Sheet Excel "Subscriptions" - handleSepayWebhook (UTC041-UTC049).
describe('Excel sheet Subscriptions - handleSepayWebhook', () => {
  let prisma: any;
  let notifications: { tenantOwners: jest.Mock; notify: jest.Mock };
  let realtime: { emitToRoom: jest.Mock };
  let service: SubscriptionBillingService;
  const saved = { ...process.env };

  const invoice = (over: Record<string, unknown> = {}) => ({
    id: 'INV1',
    tenantId: 'T1',
    planId: 'PRO',
    subscriptionId: 'S1',
    amount: 500000,
    paymentReference: 'IKMS1A2B3C4D5E',
    ...over,
  });
  const plan = (over: Record<string, unknown> = {}) => ({
    id: 'PRO',
    planCode: 'PRO',
    billingCycle: 'MONTHLY',
    maxBranches: 5,
    maxWarehouses: 5,
    maxUsers: 20,
    maxProducts: 1000,
    ...over,
  });
  const incoming = (over: Record<string, unknown> = {}) => ({
    transferType: 'in',
    content: 'Thanh toan IKMS1A2B3C4D5E',
    transferAmount: 500000,
    referenceCode: 'FT123',
    ...over,
  });

  beforeEach(() => {
    process.env.SEPAY_WEBHOOK_API_KEY = 'secret';
    prisma = {
      subscriptionInvoice: {
        findFirst: jest.fn().mockResolvedValue(invoice()),
        update: jest.fn().mockResolvedValue({}),
      },
      plan: { findUnique: jest.fn().mockResolvedValue(plan()) },
      subscription: {
        findUnique: jest.fn().mockResolvedValue({ id: 'S1', planId: 'TRIAL' }),
        update: jest.fn().mockImplementation(({ data }) =>
          Promise.resolve({
            planId: data.planId,
            status: data.status,
            endDate: data.endDate,
          }),
        ),
      },
      $transaction: jest.fn().mockImplementation((ops) => Promise.all(ops)),
    };
    notifications = {
      tenantOwners: jest.fn().mockResolvedValue(['O1', 'O2']),
      notify: jest.fn().mockResolvedValue({ notified: 2 }),
    };
    realtime = { emitToRoom: jest.fn() };
    service = new SubscriptionBillingService(
      prisma,
      new SepaySubscriptionService(),
      notifications as never,
      realtime as never,
    );
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('UTC041: a wrong API key is a 401', async () => {
    const run = service.handleSepayWebhook('wrong', incoming());
    await expect(run).rejects.toThrow(UnauthorizedException);
    await run.catch((error) => {
      expect(bodyOf(error).code).toBe('WEBHOOK_API_KEY_INVALID');
      expect(bodyOf(error).message).toBe('Invalid API key');
    });
  });

  it('UTC042: an outgoing transfer is ignored', async () => {
    await expect(
      service.handleSepayWebhook('secret', incoming({ transferType: 'out' })),
    ).resolves.toEqual({ success: true });
    expect(prisma.subscriptionInvoice.findFirst).not.toHaveBeenCalled();
  });

  it('UTC043: content without a reference is acknowledged', async () => {
    await expect(
      service.handleSepayWebhook(
        'secret',
        incoming({ content: 'chuyen khoan' }),
      ),
    ).resolves.toEqual({
      success: true,
      message: 'No matching reference found',
    });
  });

  it('UTC044: no PENDING invoice for the reference is acknowledged', async () => {
    prisma.subscriptionInvoice.findFirst.mockResolvedValue(null);
    await expect(
      service.handleSepayWebhook('secret', incoming()),
    ).resolves.toEqual({
      success: true,
      message: 'Invoice not found or already processed',
    });
    expect(prisma.subscriptionInvoice.findFirst).toHaveBeenCalledWith({
      where: { paymentReference: 'IKMS1A2B3C4D5E', status: 'PENDING' },
    });
  });

  it('UTC045: an underpaid transfer is ignored and warned about', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    await expect(
      service.handleSepayWebhook(
        'secret',
        incoming({ transferAmount: 499999 }),
      ),
    ).resolves.toEqual({ success: true, message: 'Underpaid - ignored' });
    expect(warn).toHaveBeenCalledWith(
      'Underpaid invoice INV1. Expected 500000, got 499999',
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('UTC046: payment of an upgrade activates the subscription', async () => {
    const res = await service.handleSepayWebhook('secret', incoming());
    expect(res).toEqual({ success: true, message: 'Subscription activated' });
    const { data } = prisma.subscription.update.mock.calls[0][0];
    expect(data).toEqual(
      expect.objectContaining({
        planId: 'PRO',
        status: 'ACTIVE',
        trialEndDate: null,
        quotaSnapshotMaxBranches: 5,
        quotaSnapshotMaxUsers: 20,
      }),
    );
    expect(data.endDate.getTime() - data.startDate.getTime()).toBe(30 * DAY);
    expect(data.historyLogs.create).toEqual(
      expect.objectContaining({
        event: 'UPGRADED',
        fromPlanId: 'TRIAL',
        toPlanId: 'PRO',
        changedById: null,
      }),
    );
    expect(prisma.subscriptionInvoice.update).toHaveBeenCalledWith({
      where: { id: 'INV1' },
      data: expect.objectContaining({
        status: 'PAID',
        transactionRef: 'FT123',
        paidAt: expect.any(Date),
      }),
    });
    expect(notifications.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'T1',
        recipientIds: ['O1', 'O2'],
        referenceId: 'INV1',
      }),
    );
    expect(realtime.emitToRoom).toHaveBeenCalledWith(
      'tenant:T1',
      'subscription:activated',
      expect.objectContaining({
        invoiceId: 'INV1',
        planId: 'PRO',
        status: 'ACTIVE',
      }),
    );
  });

  it('UTC047: paying for the plan already held is logged as a renewal', async () => {
    prisma.subscription.findUnique.mockResolvedValue({
      id: 'S1',
      planId: 'PRO',
    });
    await service.handleSepayWebhook('secret', incoming());
    expect(
      prisma.subscription.update.mock.calls[0][0].data.historyLogs.create.event,
    ).toBe('RENEWED');
  });

  it('UTC048: a yearly plan runs for 365 days and an overpayment is accepted', async () => {
    prisma.plan.findUnique.mockResolvedValue(plan({ billingCycle: 'YEARLY' }));
    const res = await service.handleSepayWebhook(
      'secret',
      incoming({ transferAmount: 600000 }),
    );
    expect(res.message).toBe('Subscription activated');
    const { data } = prisma.subscription.update.mock.calls[0][0];
    expect(data.endDate.getTime() - data.startDate.getTime()).toBe(365 * DAY);
  });

  it('UTC049: an internal error is answered as a failure without throwing', async () => {
    const error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    prisma.plan.findUnique.mockResolvedValue(null);
    await expect(
      service.handleSepayWebhook('secret', incoming()),
    ).resolves.toEqual({ success: false, message: 'Plan not found' });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

// Sheet Excel "Subscriptions" - assignFreeTrial (UTC050-UTC053).
describe('Excel sheet Subscriptions - assignFreeTrial', () => {
  let prisma: any;
  let service: SubscriptionService;

  beforeEach(() => {
    prisma = {
      subscription: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(({ data }) =>
          Promise.resolve({
            id: 'S1',
            status: data.status,
            trialEndDate: data.trialEndDate,
          }),
        ),
      },
      plan: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'TRIAL',
          planName: 'Trial',
          planCode: 'TRIAL',
          trialDays: 14,
          maxBranches: 1,
          maxWarehouses: 1,
          maxUsers: 3,
          maxProducts: 50,
        }),
      },
    };
    service = new SubscriptionService(prisma, {} as never);
  });

  it('UTC050: creates a TRIAL subscription lasting the plan trial days', async () => {
    const res = await service.assignFreeTrial('T1', 'U1');
    const { data } = prisma.subscription.create.mock.calls[0][0];
    expect(data).toEqual(
      expect.objectContaining({
        tenantId: 'T1',
        planId: 'TRIAL',
        status: 'TRIAL',
        autoRenew: true,
        quotaSnapshotMaxBranches: 1,
      }),
    );
    expect(data.trialEndDate.getTime() - data.startDate.getTime()).toBe(
      14 * DAY,
    );
    expect(data.endDate.getTime()).toBe(data.trialEndDate.getTime());
    expect(data.historyLogs.create).toEqual(
      expect.objectContaining({
        event: 'CREATED',
        toPlanId: 'TRIAL',
        changedById: 'U1',
      }),
    );
    expect(res.subscription.status).toBe('TRIAL');
    expect(res.plan.trialDays).toBe(14);
  });

  it('UTC051: a tenant that already has a subscription is refused', async () => {
    prisma.subscription.findFirst.mockResolvedValue({ id: 'S0' });
    const run = service.assignFreeTrial('T1', 'U1');
    await expect(run).rejects.toThrow(BadRequestException);
    await run.catch((error) => {
      expect(bodyOf(error).code).toBe('SUBSCRIPTION_ALREADY_EXISTS');
      expect(bodyOf(error).message).toBe('Tenant already has a subscription');
    });
    expect(prisma.subscription.create).not.toHaveBeenCalled();
  });

  it('UTC052: no TRIAL plan configured', async () => {
    prisma.plan.findFirst.mockResolvedValue(null);
    const run = service.assignFreeTrial('T1', 'U1');
    await expect(run).rejects.toThrow(BadRequestException);
    await run.catch((error) => {
      expect(bodyOf(error).code).toBe('TRIAL_PLAN_UNAVAILABLE');
      expect(bodyOf(error).message).toBe('Free trial plan not available');
    });
  });

  it('UTC053: only an active TRIAL plan is looked up', async () => {
    prisma.plan.findFirst.mockResolvedValue(null);
    await service.assignFreeTrial('T1', 'U1').catch(() => undefined);
    expect(prisma.plan.findFirst).toHaveBeenCalledWith({
      where: { planCode: 'TRIAL', isActive: true },
    });
  });
});

// Sheet Excel "Subscriptions" - initiateUpgrade / initiateRenewal / createPlanInvoice (UTC054-UTC064).
describe('Excel sheet Subscriptions - invoices', () => {
  let prisma: any;
  let service: SubscriptionBillingService;
  const saved = { ...process.env };

  const pro = (over: Record<string, unknown> = {}) => ({
    id: 'PRO',
    planCode: 'PRO',
    planName: 'Pro',
    price: 500000,
    billingCycle: 'MONTHLY',
    ...over,
  });

  beforeEach(() => {
    process.env.SEPAY_ACCOUNT_NUMBER = '999';
    process.env.SEPAY_BANK_NAME = 'VCB';
    process.env.SEPAY_ACCOUNT_NAME = 'IKIOT';
    prisma = {
      subscription: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'S1',
          tenantId: 'T1',
          plan: pro({ id: 'PRO' }),
        }),
      },
      plan: { findFirst: jest.fn().mockResolvedValue(pro()) },
      subscriptionInvoice: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn().mockResolvedValue({ id: 'INV1' }),
      },
    };
    service = new SubscriptionBillingService(
      prisma,
      new SepaySubscriptionService(),
      {} as never,
      {} as never,
    );
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  const expectBad = async (
    run: Promise<unknown>,
    code: string,
    message: string,
  ) => {
    await expect(run).rejects.toThrow(BadRequestException);
    await run.catch((error) => {
      expect(bodyOf(error).code).toBe(code);
      expect(bodyOf(error).message).toBe(message);
    });
    expect(prisma.subscriptionInvoice.create).not.toHaveBeenCalled();
  };

  it('UTC054: an upgrade raises a PENDING invoice with a 15-minute QR', async () => {
    const before = Date.now();
    const res = await service.initiateUpgrade('T1', 'PRO');
    expect(res).toEqual(
      expect.objectContaining({
        invoiceId: 'INV1',
        amount: 500000,
        plan: { planCode: 'PRO', planName: 'Pro' },
      }),
    );
    expect(res.paymentReference).toMatch(/^IKMS[0-9A-F]{10}$/);
    expect(res.qrDataUrl).toContain('amount=500000');
    expect(res.qrDataUrl).toContain(`addInfo=${res.paymentReference}`);
    expect(res.expiredAt.getTime() - before).toBeGreaterThanOrEqual(
      15 * 60 * 1000,
    );
    expect(res.expiredAt.getTime() - before).toBeLessThan(
      15 * 60 * 1000 + 5000,
    );
    const { data } = prisma.subscriptionInvoice.create.mock.calls[0][0];
    expect(data).toEqual(
      expect.objectContaining({
        subscriptionId: 'S1',
        tenantId: 'T1',
        planId: 'PRO',
        amount: 500000,
        currency: 'VND',
        status: 'PENDING',
        paymentMethod: 'SEPAY',
      }),
    );
    expect(
      data.billingPeriodEnd.getTime() - data.billingPeriodStart.getTime(),
    ).toBe(30 * DAY);
  });

  it('UTC055: no subscription', async () => {
    prisma.subscription.findFirst.mockResolvedValue(null);
    await expectBad(
      service.initiateUpgrade('T1', 'PRO'),
      'SUBSCRIPTION_NOT_FOUND',
      'No active subscription found',
    );
  });

  it('UTC056: unknown or inactive plan', async () => {
    prisma.plan.findFirst.mockResolvedValue(null);
    await expectBad(
      service.initiateUpgrade('T1', 'NOPE'),
      'PLAN_NOT_FOUND',
      'Plan NOPE not found or inactive',
    );
    expect(prisma.plan.findFirst).toHaveBeenCalledWith({
      where: { planCode: 'NOPE', isActive: true },
    });
  });

  it('UTC057: a free plan cannot be bought', async () => {
    prisma.plan.findFirst.mockResolvedValue(
      pro({ price: 0, planCode: 'TRIAL' }),
    );
    await expectBad(
      service.initiateUpgrade('T1', 'TRIAL'),
      'PLAN_IS_FREE',
      'Use free-trial endpoint for free plans',
    );
  });

  it('UTC058: a yearly plan is billed for 365 days', async () => {
    prisma.plan.findFirst.mockResolvedValue(pro({ billingCycle: 'YEARLY' }));
    await service.initiateUpgrade('T1', 'PRO_YEARLY');
    const { data } = prisma.subscriptionInvoice.create.mock.calls[0][0];
    expect(
      data.billingPeriodEnd.getTime() - data.billingPeriodStart.getTime(),
    ).toBe(365 * DAY);
  });

  it('UTC059: a renewal invoices the current plan', async () => {
    const res = await service.initiateRenewal('T1');
    expect(res.plan.planCode).toBe('PRO');
    expect(res.amount).toBe(500000);
    expect(prisma.subscriptionInvoice.create.mock.calls[0][0].data.planId).toBe(
      'PRO',
    );
  });

  it('UTC060: renewal without a subscription', async () => {
    prisma.subscription.findFirst.mockResolvedValue(null);
    await expectBad(
      service.initiateRenewal('T1'),
      'SUBSCRIPTION_NOT_FOUND',
      'No subscription found',
    );
  });

  it('UTC061: renewal when the subscription has no plan', async () => {
    prisma.subscription.findFirst.mockResolvedValue({
      id: 'S1',
      tenantId: 'T1',
      plan: null,
    });
    await expectBad(
      service.initiateRenewal('T1'),
      'PLAN_NOT_FOUND',
      'Current plan not found',
    );
  });

  it('UTC062: the trial plan cannot be renewed', async () => {
    prisma.subscription.findFirst.mockResolvedValue({
      id: 'S1',
      tenantId: 'T1',
      plan: pro({ planCode: 'TRIAL', price: 0 }),
    });
    await expectBad(
      service.initiateRenewal('T1'),
      'TRIAL_CANNOT_RENEW',
      'Trial plan cannot be renewed. Please upgrade to a paid plan.',
    );
  });

  it('UTC063: earlier PENDING invoices of the same plan are cancelled before the new one is created', async () => {
    await service.initiateUpgrade('T1', 'PRO');
    expect(prisma.subscriptionInvoice.updateMany).toHaveBeenCalledWith({
      where: { tenantId: 'T1', planId: 'PRO', status: 'PENDING' },
      data: { status: 'FAILED' },
    });
    expect(
      prisma.subscriptionInvoice.updateMany.mock.invocationCallOrder[0],
    ).toBeLessThan(
      prisma.subscriptionInvoice.create.mock.invocationCallOrder[0],
    );
  });

  it('UTC064: only invoices of the plan being bought are cancelled', async () => {
    prisma.plan.findFirst.mockResolvedValue(
      pro({ id: 'PLUS', planCode: 'PLUS' }),
    );
    await service.initiateUpgrade('T1', 'PLUS');
    expect(
      prisma.subscriptionInvoice.updateMany.mock.calls[0][0].where.planId,
    ).toBe('PLUS');
  });
});
