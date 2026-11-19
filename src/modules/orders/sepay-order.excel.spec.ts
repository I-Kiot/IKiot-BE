import { BadRequestException, Logger } from '@nestjs/common';
import { OrderService } from './orders.service';
import { SepayOrderService } from './sepay-order.service';

// Excel sheet "Orders" - SepayOrderService (UTC042-UTC053).
describe('Excel sheet Orders - SepayOrderService', () => {
  let prisma: { tenant: { findFirst: jest.Mock } };
  let service: SepayOrderService;

  beforeEach(() => {
    prisma = { tenant: { findFirst: jest.fn() } };
    service = new SepayOrderService(prisma as never);
  });

  describe('generateOrderReference', () => {
    it('UTC042: starts with ORD, followed by hex, and differs between calls', () => {
      const a = service.generateOrderReference();
      const b = service.generateOrderReference();
      expect(a).toMatch(/^ORD[0-9A-F]{10}$/);
      expect(a).not.toBe(b);
    });
  });

  describe('buildQrUrl', () => {
    const banking = {
      bankingBankName: 'MB',
      bankingAccountNumber: '0123456789',
      bankingAccountName: 'NGUYEN VAN A',
    };
    it('UTC043: builds the VietQR link from the shop bank account', () => {
      expect(service.buildQrUrl(banking, 150000, 'ORD1A2B3C4D5E')).toBe(
        'https://img.vietqr.io/image/MB-0123456789-compact2.png?amount=150000&addInfo=ORD1A2B3C4D5E&accountName=NGUYEN%20VAN%20A',
      );
    });
    it('UTC044: the account name is URL-encoded', () => {
      const url = service.buildQrUrl(
        { ...banking, bankingAccountName: 'Nguyễn Văn A' },
        1000,
        'ORD1',
      );
      expect(url).toContain(
        `accountName=${encodeURIComponent('Nguyễn Văn A')}`,
      );
    });
    it('UTC045: null banking fields give empty segments without throwing', () => {
      const url = service.buildQrUrl(
        {
          bankingBankName: null,
          bankingAccountNumber: null,
          bankingAccountName: null,
        },
        1000,
        'ORD1',
      );
      expect(url).toBe(
        'https://img.vietqr.io/image/--compact2.png?amount=1000&addInfo=ORD1&accountName=',
      );
    });
  });

  describe('extractOrderReference', () => {
    it('UTC046: finds the reference inside free text', () => {
      expect(
        service.extractOrderReference('Thanh toan ORD1A2B3C4D5E cam on'),
      ).toBe('ORD1A2B3C4D5E');
    });
    it('UTC047: is case-insensitive and accepts the 6-hex legacy format', () => {
      expect(service.extractOrderReference('thanh toan ord1a2b3c')).toBe(
        'ORD1A2B3C',
      );
    });
    it('UTC048: four hex characters are too short', () => {
      expect(service.extractOrderReference('ORD1A2B')).toBeNull();
    });
    it('UTC049: at most ten hex characters are taken', () => {
      expect(service.extractOrderReference('ORD1A2B3C4D5E6F7')).toBe(
        'ORD1A2B3C4D5E',
      );
    });
    it.each([['chuyen khoan'], [''], [undefined]])(
      'UTC050: no reference in %p gives null',
      (content) => {
        expect(service.extractOrderReference(content)).toBeNull();
      },
    );
  });

  describe('findTenantByWebhookKey', () => {
    it('UTC051: a known key resolves to the tenant id', async () => {
      prisma.tenant.findFirst.mockResolvedValue({ id: 'T1' });
      await expect(service.findTenantByWebhookKey('key-1')).resolves.toEqual({
        id: 'T1',
      });
      expect(prisma.tenant.findFirst).toHaveBeenCalledWith({
        where: { bankingSepayWebhookApiKey: 'key-1' },
        select: { id: true },
      });
    });
    it('UTC052: an unknown key resolves to null', async () => {
      prisma.tenant.findFirst.mockResolvedValue(null);
      await expect(
        service.findTenantByWebhookKey('unknown'),
      ).resolves.toBeNull();
    });
    it('UTC053: an empty key resolves to null without a query', async () => {
      await expect(service.findTenantByWebhookKey('')).resolves.toBeNull();
      expect(prisma.tenant.findFirst).not.toHaveBeenCalled();
    });
  });
});

// Excel sheet "Orders" - completeSepayOrder (UTC054-UTC060).
describe('Excel sheet Orders - completeSepayOrder', () => {
  let prisma: any;
  let tx: any;
  let realtime: { emitToRoom: jest.Mock; emitToRoomExcept: jest.Mock };
  let notifications: { managersOfLocation: jest.Mock; notify: jest.Mock };
  let service: OrderService;

  const settled = {
    id: 'O1',
    tenantId: 'T1',
    branchId: 'BR-01',
    userId: 'U1',
    status: 'COMPLETED',
    paymentMethod: 'SEPAY',
    paymentReference: 'ORD1A2B3C4D5E',
    grandTotal: 150000,
    customerPay: null,
    change: null,
    discountValue: 0,
    items: [],
    appliedPromotions: [],
  };

  beforeEach(() => {
    tx = {
      order: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue(settled),
      },
      cashFlow: { create: jest.fn().mockResolvedValue({}) },
    };
    prisma = {
      order: { findFirst: jest.fn() },
      $transaction: jest.fn().mockImplementation((fn) => fn(tx)),
    };
    realtime = { emitToRoom: jest.fn(), emitToRoomExcept: jest.fn() };
    notifications = {
      managersOfLocation: jest.fn().mockResolvedValue(['M1']),
      notify: jest.fn().mockResolvedValue({ notified: 2 }),
    };
    service = new OrderService(
      prisma,
      {} as never,
      notifications as never,
      realtime as never,
      {} as never,
      {} as never,
    );
  });

  const pendingFound = (grandTotal = 150000) =>
    prisma.order.findFirst.mockImplementation(({ where }: any) =>
      Promise.resolve(where.status ? { id: 'O1', grandTotal } : null),
    );

  it('UTC054: exact transfer completes the order and records an INCOME', async () => {
    pendingFound();
    const res = await service.completeSepayOrder(
      'T1',
      'ORD1A2B3C4D5E',
      '9001',
      150000,
    );
    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'O1', status: 'PENDING' },
      data: { status: 'COMPLETED', sepayTransactionId: '9001' },
    });
    expect(tx.cashFlow.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        flowType: 'INCOME',
        amount: 150000,
        paymentMethod: 'SEPAY',
        paymentReference: 'ORD1A2B3C4D5E',
        sepayTransactionId: '9001',
      }),
    });
    expect(res?.status).toBe('COMPLETED');
    expect(realtime.emitToRoom).toHaveBeenCalledWith(
      'tenant:T1',
      'order:paid',
      expect.objectContaining({ orderId: 'O1', paidAmount: 150000 }),
    );
    expect(notifications.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'T1',
        recipientIds: ['U1', 'M1'],
        referenceId: 'O1',
      }),
    );
  });

  it('UTC055: an overpaid transfer records the amount received', async () => {
    pendingFound();
    await service.completeSepayOrder('T1', 'ORD1A2B3C4D5E', '9001', 200000);
    expect(tx.cashFlow.create.mock.calls[0][0].data.amount).toBe(200000);
  });

  it('UTC056: a short transfer is refused and the order stays pending', async () => {
    pendingFound();
    const run = service.completeSepayOrder(
      'T1',
      'ORD1A2B3C4D5E',
      '9001',
      149999,
    );
    await expect(run).rejects.toThrow(BadRequestException);
    await run.catch((error) => {
      const body = error.getResponse();
      expect(body.code).toBe('ORDER_TRANSFER_AMOUNT_SHORT');
      expect(body.message).toBe(
        'Transfer is short: 150000 due, 149999 received',
      );
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('UTC057: an unknown reference returns null', async () => {
    prisma.order.findFirst.mockResolvedValue(null);
    await expect(
      service.completeSepayOrder('T1', 'ORD000000', null, 150000),
    ).resolves.toBeNull();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('UTC058: an order already settled by cash returns null and logs a refund warning', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    prisma.order.findFirst.mockImplementation(({ where }: any) =>
      Promise.resolve(
        where.status
          ? null
          : { id: 'O9', status: 'COMPLETED', paymentMethod: 'CASH' },
      ),
    );
    await expect(
      service.completeSepayOrder('T1', 'ORD1A2B3C4D5E', '9001', 150000),
    ).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'order O9 is already COMPLETED via CASH. Manual refund may be required.',
      ),
    );
    warn.mockRestore();
  });

  it('UTC059: the lookup is limited to the webhook tenant', async () => {
    prisma.order.findFirst.mockResolvedValue(null);
    await service.completeSepayOrder('T2', 'ORD1A2B3C4D5E', null, 150000);
    expect(prisma.order.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 'T2' }),
      }),
    );
  });

  it('UTC060: an order claimed by another request meanwhile returns null with no cash flow', async () => {
    pendingFound();
    tx.order.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      service.completeSepayOrder('T1', 'ORD1A2B3C4D5E', '9001', 150000),
    ).resolves.toBeNull();
    expect(tx.cashFlow.create).not.toHaveBeenCalled();
    expect(realtime.emitToRoom).not.toHaveBeenCalled();
  });
});
