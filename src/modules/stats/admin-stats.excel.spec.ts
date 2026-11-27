import { AdminStatsService } from './admin-stats.service';

// Sheet Excel "Stats" - getOverview (UTC020-UTC030).
describe('Excel sheet Stats - getOverview', () => {
  let prisma: any;
  let service: AdminStatsService;

  const query = (groupBy?: string) =>
    ({
      groupBy,
      range: () => ({
        fromDate: new Date('2026-11-01T00:00:00Z'),
        toDate: new Date('2026-11-30T23:59:59Z'),
      }),
    }) as never;

  /** Số đếm theo trạng thái dạng kết quả groupBy của Prisma. */
  const counts = (obj: Record<string, number>, key = 'status') =>
    Object.entries(obj).map(([value, n]) => ({
      [key]: value,
      _count: { _all: n },
    }));

  beforeEach(() => {
    prisma = {
      tenant: {
        groupBy: jest.fn().mockResolvedValue([]),
        // Thứ tự gọi: tổng, mới trong kỳ, mới kỳ trước, đã liên kết SePay.
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
      },
      subscription: {
        groupBy: jest
          .fn()
          .mockImplementation(({ by }) =>
            Promise.resolve(by.includes('status') ? [] : []),
          ),
      },
      subscriptionInvoice: {
        aggregate: jest
          .fn()
          .mockResolvedValue({ _sum: { amount: null }, _count: { _all: 0 } }),
        groupBy: jest.fn().mockResolvedValue([]),
        findMany: jest.fn().mockResolvedValue([]),
      },
      plan: { findMany: jest.fn().mockResolvedValue([]) },
      ticket: { groupBy: jest.fn().mockResolvedValue([]) },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    service = new AdminStatsService(prisma);
  });

  const tenantCounts = (...n: number[]) =>
    n.forEach((v) => prisma.tenant.count.mockResolvedValueOnce(v));

  it('UTC020: tenants by status, new in the period and the change against the previous period', async () => {
    prisma.tenant.groupBy.mockResolvedValue(
      counts({ ACTIVE: 2, SUSPENDED: 1 }),
    );
    tenantCounts(3, 1, 2, 0);
    const res = await service.getOverview(query());
    expect(res.tenants).toEqual({
      total: 3,
      active: 2,
      inactive: 0,
      suspended: 1,
      newInPeriod: 1,
      changePct: -50,
    });
  });

  it('UTC021: no tenant in the previous period gives a null change', async () => {
    tenantCounts(3, 1, 0, 0);
    expect((await service.getOverview(query())).tenants.changePct).toBeNull();
  });

  it('UTC022: subscription statuses default to zero and the conversion rate counts paying over decided', async () => {
    prisma.subscription.groupBy.mockImplementation(({ by }: any) =>
      Promise.resolve(
        by.includes('status')
          ? counts({ TRIAL: 1, ACTIVE: 2, PAST_DUE: 1, EXPIRED: 1 })
          : [],
      ),
    );
    const res = await service.getOverview(query());
    expect(res.subscriptions.byStatus).toEqual({
      TRIAL: 1,
      ACTIVE: 2,
      PAST_DUE: 1,
      EXPIRED: 1,
      CANCELLED: 0,
    });
    expect(res.subscriptions.conversionRate).toBe(75);
  });

  it('UTC023: with no decided subscription the conversion rate is null', async () => {
    prisma.subscription.groupBy.mockImplementation(({ by }: any) =>
      Promise.resolve(by.includes('status') ? counts({ TRIAL: 4 }) : []),
    );
    expect(
      (await service.getOverview(query())).subscriptions.conversionRate,
    ).toBeNull();
  });

  it('UTC024: plan distribution counts live subscriptions only, biggest plan first', async () => {
    prisma.subscription.groupBy.mockImplementation(({ by }: any) =>
      Promise.resolve(
        by.includes('planId')
          ? [
              { planId: 'PLUS', _count: { _all: 1 } },
              { planId: 'PRO', _count: { _all: 3 } },
            ]
          : [],
      ),
    );
    prisma.plan.findMany.mockResolvedValue([
      { id: 'PRO', planCode: 'PRO', planName: 'Pro' },
      { id: 'PLUS', planCode: 'PLUS', planName: 'Plus' },
    ]);
    const res = await service.getOverview(query());
    expect(res.subscriptions.planDistribution).toEqual([
      { planId: 'PRO', planCode: 'PRO', planName: 'Pro', count: 3 },
      { planId: 'PLUS', planCode: 'PLUS', planName: 'Plus', count: 1 },
    ]);
    const live = prisma.subscription.groupBy.mock.calls
      .map((c: any[]) => c[0])
      .find((a: any) => a.by.includes('planId'));
    expect(live.where).toEqual({
      status: { in: ['TRIAL', 'ACTIVE', 'PAST_DUE'] },
    });
  });

  it('UTC025: revenue counts only PAID invoices by the date they were paid', async () => {
    prisma.subscriptionInvoice.aggregate.mockImplementation(
      ({ where }: any) => {
        if (!where.paidAt)
          return Promise.resolve({
            _sum: { amount: 5000000 },
            _count: { _all: 9 },
          });
        return Promise.resolve(
          where.paidAt.gte.getTime() ===
            new Date('2026-11-01T00:00:00Z').getTime()
            ? { _sum: { amount: 700000 }, _count: { _all: 2 } }
            : { _sum: { amount: 350000 }, _count: { _all: 1 } },
        );
      },
    );
    const res = await service.getOverview(query());
    expect(res.revenue).toEqual(
      expect.objectContaining({
        total: 5000000,
        inPeriod: 700000,
        invoiceCountInPeriod: 2,
        changePct: 100,
      }),
    );
    const periodQuery = prisma.subscriptionInvoice.aggregate.mock.calls
      .map((c: any[]) => c[0])
      .find((a: any) => a.where.paidAt);
    expect(periodQuery.where.status).toBe('PAID');
  });

  it('UTC026: open tickets are OPEN and IN_PROGRESS, resolved are RESOLVED and CLOSED', async () => {
    prisma.ticket.groupBy.mockResolvedValue(
      counts({ OPEN: 2, IN_PROGRESS: 1, RESOLVED: 1, CLOSED: 3 }),
    );
    expect((await service.getOverview(query())).tickets).toEqual({
      open: 3,
      resolved: 4,
      total: 7,
    });
  });

  it('UTC027: SePay linked counts tenants with a non-empty key', async () => {
    tenantCounts(5, 0, 0, 2);
    const res = await service.getOverview(query());
    expect(res.sepay).toEqual({ linked: 2, total: 5 });
    expect(prisma.tenant.count.mock.calls[3][0].where).toEqual({
      bankingSepayWebhookApiKey: { not: null },
      NOT: { bankingSepayWebhookApiKey: '' },
    });
  });

  it('UTC028: top tenants are the five biggest payers with their names', async () => {
    prisma.subscriptionInvoice.groupBy.mockResolvedValue([
      { tenantId: 'T1', _sum: { amount: 900000 }, _count: { _all: 3 } },
      { tenantId: 'T2', _sum: { amount: 500000 }, _count: { _all: 1 } },
    ]);
    prisma.tenant.findMany.mockResolvedValue([
      { id: 'T1', name: 'Cua hang A' },
    ]);
    const res = await service.getOverview(query());
    expect(res.topTenants).toEqual([
      { tenantId: 'T1', name: 'Cua hang A', revenue: 900000, invoiceCount: 3 },
      { tenantId: 'T2', name: null, revenue: 500000, invoiceCount: 1 },
    ]);
    expect(prisma.subscriptionInvoice.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: 'PAID' },
        orderBy: { _sum: { amount: 'desc' } },
        take: 5,
      }),
    );
  });

  it('UTC029: recent invoices are the eight newest', async () => {
    prisma.subscriptionInvoice.findMany.mockResolvedValue([{ id: 'I1' }]);
    const res = await service.getOverview(query());
    expect(res.recentInvoices).toEqual([{ id: 'I1' }]);
    expect(prisma.subscriptionInvoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: 'desc' }, take: 8 }),
    );
  });

  it.each([
    ['month', 'month'],
    [undefined, 'day'],
    ['week', 'day'],
  ])(
    'UTC030: groupBy %p is answered as %p buckets',
    async (input, expected) => {
      const res = await service.getOverview(query(input));
      expect(res.revenue.groupBy).toBe(expected);
    },
  );
});
