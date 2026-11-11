import 'dotenv/config';
import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { NotificationService } from './../src/modules/notifications/notifications.service';
import { RealtimeGateway } from './../src/common/realtime/realtime.gateway';
import { SubscriptionBillingService } from './../src/modules/subscriptions/subscription-billing.service';
import { deleteTenantMoneyTrail } from './helpers/cleanup-money';
import { assertMoneyInvariants } from './helpers/money-invariants';

const PLATFORM_ACCOUNT = '0123456789';
const KEY = 'platform-billing-key';
const MARK = 'pb-e2e';

/**
 * Phase 5 của sổ tiền (Postgres thật): webhook SePay của tài khoản iKiot. Hoá đơn gói bị chiếm có điều kiện trước khi kích hoạt gói, và mọi lần tiền về đều vào `platform_sepay_transactions`.
 */
describe('platform SePay webhook', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let billing: SubscriptionBillingService;
  const notify = jest.fn();
  const notifySystem = jest.fn();
  const emit = jest.fn();

  const tenantId = randomUUID();
  const planId = randomUUID();
  const trialPlanId = randomUUID();
  const subscriptionId = randomUUID();
  const planCode = `PB-${planId.slice(0, 8)}`;
  let txCounter = 770_000;
  let refCounter = 0;

  const makeInvoice = async (
    status = 'PENDING',
    amount = 500_000,
  ): Promise<{ id: string; ref: string }> => {
    const suffix = (Date.now() % 0xfffff)
      .toString(16)
      .toUpperCase()
      .padStart(6, '0');
    const ref = `IKMS${suffix}${(++refCounter).toString(16).toUpperCase().padStart(2, '0')}`;
    const invoice = await prisma.subscriptionInvoice.create({
      data: {
        subscriptionId,
        tenantId,
        planId,
        amount,
        status,
        paymentReference: ref,
        paymentMethod: 'SEPAY',
        billingPeriodStart: new Date(),
        billingPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
      },
    });
    return { id: invoice.id, ref };
  };

  const transfer = (content: string, amount: number, id?: number) =>
    billing.handleSepayWebhook(KEY, {
      transferType: 'in',
      accountNumber: PLATFORM_ACCOUNT,
      content,
      transferAmount: amount,
      id: id ?? ++txCounter,
    });

  const ledgerOf = (invoiceId: string) =>
    prisma.platformSepayTransaction.findMany({
      where: { subscriptionInvoiceId: invoiceId },
      orderBy: { createdAt: 'asc' },
    });

  beforeAll(async () => {
    process.env.SEPAY_WEBHOOK_API_KEY = KEY;
    process.env.SEPAY_ACCOUNT_NUMBER = PLATFORM_ACCOUNT;
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    billing = app.get(SubscriptionBillingService);
    const notifications = app.get(NotificationService);
    jest
      .spyOn(notifications, 'notify')
      .mockImplementation(notify.mockResolvedValue({ notified: 0 }));
    jest
      .spyOn(notifications, 'notifySystem')
      .mockImplementation(notifySystem.mockResolvedValue(undefined));
    jest.spyOn(app.get(RealtimeGateway), 'emitToRoom').mockImplementation(emit);

    await prisma.tenant.create({
      data: { id: tenantId, name: 'platform-billing-e2e' },
    });
    for (const [id, code, price] of [
      [planId, planCode, 500_000],
      [trialPlanId, `${planCode}-T`, 0],
    ] as const) {
      await prisma.plan.create({
        data: {
          id,
          planName: code,
          planCode: code,
          price,
          billingCycle: 'MONTHLY',
          maxBranches: 5,
          maxWarehouses: 5,
          maxUsers: 5,
          maxProducts: 100,
          trialDays: 0,
        },
      });
    }
    await prisma.subscription.create({
      data: {
        id: subscriptionId,
        tenantId,
        planId: trialPlanId,
        status: 'TRIAL',
        startDate: new Date(),
        endDate: new Date(Date.now() + 86_400_000),
      },
    });
  });

  afterAll(async () => {
    delete process.env.SEPAY_WEBHOOK_API_KEY;
    delete process.env.SEPAY_ACCOUNT_NUMBER;
    await prisma.platformSepayTransaction.deleteMany({
      where: { content: { startsWith: MARK } },
    });
    await deleteTenantMoneyTrail(prisma, tenantId);
    await prisma.subscriptionHistoryLog.deleteMany({
      where: { subscriptionId },
    });
    await prisma.subscriptionInvoice.deleteMany({ where: { tenantId } });
    await prisma.subscription.deleteMany({ where: { tenantId } });
    await prisma.plan.deleteMany({
      where: { id: { in: [planId, trialPlanId] } },
    });
    await prisma.tenant.delete({ where: { id: tenantId } });
    await app.close();
  });

  beforeEach(() => {
    notify.mockClear();
    notifySystem.mockClear();
    emit.mockClear();
  });

  it('activates the plan once: the ledger row, the claimed invoice and the subscription agree', async () => {
    const { id, ref } = await makeInvoice();
    const result = await transfer(`pay ${ref}`, 500_000);
    expect(result).toMatchObject({
      success: true,
      message: 'Subscription activated',
    });

    const invoice = await prisma.subscriptionInvoice.findUniqueOrThrow({
      where: { id },
    });
    expect(invoice.status).toBe('PAID');
    expect(Number(invoice.amountReceived)).toBe(500_000);
    expect(invoice.paidAt).not.toBeNull();
    const sub = await prisma.subscription.findUniqueOrThrow({
      where: { id: subscriptionId },
    });
    expect(sub.status).toBe('ACTIVE');
    expect(sub.planId).toBe(planId);
    const rows = await ledgerOf(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'ACTIVATED', tenantId });
    expect(emit).toHaveBeenCalledWith(
      `tenant:${tenantId}`,
      'subscription:activated',
      expect.anything(),
    );
    expect(notifySystem).not.toHaveBeenCalled();
  });

  it('a double delivery of the same transaction activates once and leaves one ledger row', async () => {
    const { id, ref } = await makeInvoice();
    const txId = ++txCounter;
    const [a, b] = await Promise.all([
      transfer(`pay ${ref}`, 500_000, txId),
      transfer(`pay ${ref}`, 500_000, txId),
    ]);
    expect([a.message, b.message].sort()).toEqual([
      'Duplicate transaction',
      'Subscription activated',
    ]);
    expect(await ledgerOf(id)).toHaveLength(1);
    expect(
      await prisma.subscriptionHistoryLog.count({
        where: { subscriptionId, note: { contains: ref } },
      }),
    ).toBe(1);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('two different transfers for one invoice: one activates, the other lands as INVOICE_NOT_PENDING and alerts the operator', async () => {
    const { id, ref } = await makeInvoice();
    await Promise.all([
      transfer(`a ${ref}`, 500_000),
      transfer(`b ${ref}`, 500_000),
    ]);
    const rows = await ledgerOf(id);
    expect(rows.map((r) => r.outcome).sort()).toEqual([
      'ACTIVATED',
      'INVOICE_NOT_PENDING',
    ]);
    expect(notifySystem).toHaveBeenCalledTimes(1);
    expect(notifySystem.mock.calls[0][0]).toMatchObject({
      type: 'SYSTEM_PLATFORM_TRANSFER_NEEDS_ACTION',
    });
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('a transfer for a FAILED invoice is recorded and does not activate (decision 10)', async () => {
    const before = await prisma.subscription.findUniqueOrThrow({
      where: { id: subscriptionId },
    });
    const { id, ref } = await makeInvoice('FAILED');
    const result = await transfer(`late ${ref}`, 500_000);
    expect(result.success).toBe(true);
    const rows = await ledgerOf(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('INVOICE_NOT_PENDING');
    expect(
      (await prisma.subscriptionInvoice.findUniqueOrThrow({ where: { id } }))
        .status,
    ).toBe('FAILED');
    const after = await prisma.subscription.findUniqueOrThrow({
      where: { id: subscriptionId },
    });
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(notifySystem).toHaveBeenCalledTimes(1);
  });

  it('underpaid: recorded with the amount received, the invoice stays PENDING, several short transfers never activate (D6)', async () => {
    const { id, ref } = await makeInvoice();
    await transfer(`s1 ${ref}`, 200_000);
    await transfer(`s2 ${ref}`, 200_000);
    const invoice = await prisma.subscriptionInvoice.findUniqueOrThrow({
      where: { id },
    });
    expect(invoice.status).toBe('PENDING');
    expect(Number(invoice.amountReceived)).toBe(200_000);
    const rows = await ledgerOf(id);
    expect(rows.map((r) => r.outcome)).toEqual(['UNDERPAID', 'UNDERPAID']);
    expect(notifySystem).toHaveBeenCalledTimes(2);
    // The full transfer later still activates it.
    const ok = await transfer(`full ${ref}`, 500_000);
    expect(ok.message).toBe('Subscription activated');
    expect(
      (await prisma.subscriptionInvoice.findUniqueOrThrow({ where: { id } }))
        .status,
    ).toBe('PAID');
  });

  it('no reference, unknown reference and a transfer without an id each leave exactly one row; replaying the id-less payload is a duplicate', async () => {
    const payload = {
      transferType: 'in',
      accountNumber: PLATFORM_ACCOUNT,
      content: `${MARK} no code here`,
      transferAmount: 123_000,
      transactionDate: '2026-11-11 10:00:00',
    };
    const none = await billing.handleSepayWebhook(KEY, payload);
    const again = await billing.handleSepayWebhook(KEY, payload);
    expect(none.message).toContain('No matching reference');
    expect(again.message).toBe('Duplicate transaction');
    const unknown = await transfer(`${MARK} IKMSDEAD00BEEF`, 50_000);
    expect(unknown.message).toContain('No invoice with this reference');

    const rows = await prisma.platformSepayTransaction.findMany({
      where: { content: { startsWith: MARK } },
    });
    expect(rows.map((r) => r.outcome).sort()).toEqual([
      'NO_REFERENCE',
      'UNMATCHED',
    ]);
    expect(notifySystem).toHaveBeenCalledTimes(2);
  });

  it('leaves the ledgers consistent', async () => {
    await assertMoneyInvariants(prisma, tenantId);
  });

  it('money that reached a shop account is not a platform transfer: no ledger row', async () => {
    const before = await prisma.platformSepayTransaction.count();
    await billing.handleSepayWebhook(KEY, {
      transferType: 'in',
      accountNumber: '9999999999',
      content: 'IKMS000000AA',
      transferAmount: 1,
      id: ++txCounter,
    });
    expect(await prisma.platformSepayTransaction.count()).toBe(before);
  });
});
