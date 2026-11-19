import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { OrderService } from './orders.service';

const codeOf = (error: unknown) =>
  (error as ConflictException).getResponse() as {
    code: string;
    message: string;
  };

// Excel sheet "Orders" - updateStatus (UTC025-UTC034) and payOffline (UTC035-UTC041).
describe('Excel sheet Orders - updateStatus / payOffline', () => {
  const TENANT = 'T1';
  const owner = { userId: 'U2', systemRole: 'TENANT_OWNER' } as never;
  const cashier = {
    userId: 'U1',
    branchId: 'BR-01',
    systemRole: 'STAFF',
    permissions: new Set(),
  } as never;

  let prisma: any;
  let tx: any;
  let inventory: { adjustStock: jest.Mock };
  let realtime: { emitToRoom: jest.Mock; emitToRoomExcept: jest.Mock };
  let service: OrderService;
  let flows: jest.SpyInstance;

  const order = (over: Record<string, unknown> = {}) => ({
    id: 'O1',
    tenantId: TENANT,
    branchId: 'BR-01',
    userId: 'U1',
    status: 'PENDING',
    paymentMethod: 'CASH',
    paymentReference: 'ORD1A2B3C',
    grandTotal: 200000,
    customerPay: null,
    change: null,
    discountValue: 0,
    items: [
      { productItemId: 'PI-01', quantity: 3, unitPrice: 1, discountAmount: 0 },
      { productItemId: 'PI-02', quantity: 1, unitPrice: 1, discountAmount: 0 },
    ],
    appliedPromotions: [],
    ...over,
  });

  beforeEach(() => {
    tx = {
      order: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn(),
      },
      cashFlow: { create: jest.fn().mockResolvedValue({}) },
    };
    prisma = {
      order: { findFirst: jest.fn() },
      $transaction: jest.fn().mockImplementation((fn) => fn(tx)),
    };
    inventory = { adjustStock: jest.fn().mockResolvedValue(undefined) };
    realtime = { emitToRoom: jest.fn(), emitToRoomExcept: jest.fn() };
    service = new OrderService(
      prisma,
      inventory as never,
      {} as never,
      realtime as never,
      {} as never,
      {} as never,
    );
    flows = jest
      .spyOn(service as any, 'writeSaleCashFlows')
      .mockResolvedValue(undefined);
  });

  /** Order read first as `before`, then re-read inside the transaction as `after`. */
  const given = (before: Record<string, unknown>, after = before) => {
    prisma.order.findFirst.mockResolvedValue(order(before));
    tx.order.findUniqueOrThrow.mockResolvedValue(order(after));
  };

  describe('updateStatus', () => {
    it('UTC025: PENDING to COMPLETED writes the sale cash flows', async () => {
      given({ status: 'PENDING' }, { status: 'COMPLETED' });
      const res = await service.updateStatus(owner, TENANT, 'O1', 'COMPLETED');
      expect(res.status).toBe('COMPLETED');
      expect(flows).toHaveBeenCalledTimes(1);
      expect(inventory.adjustStock).not.toHaveBeenCalled();
    });

    it('UTC026: PENDING to CANCELLED returns the stock of every line and writes no refund', async () => {
      given({ status: 'PENDING' }, { status: 'CANCELLED' });
      const res = await service.updateStatus(owner, TENANT, 'O1', 'CANCELLED');
      expect(res.status).toBe('CANCELLED');
      expect(inventory.adjustStock).toHaveBeenCalledTimes(2);
      expect(inventory.adjustStock).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          productItemId: 'PI-01',
          branchId: 'BR-01',
          warehouseId: null,
          delta: 3,
        }),
      );
      expect(inventory.adjustStock).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({ productItemId: 'PI-02', delta: 1 }),
      );
      expect(tx.cashFlow.create).not.toHaveBeenCalled();
    });

    it('UTC027: COMPLETED to RETURNED returns the stock and posts an EXPENSE of the grand total', async () => {
      given(
        { status: 'COMPLETED', grandTotal: 500000 },
        { status: 'RETURNED', grandTotal: 500000 },
      );
      const res = await service.updateStatus(owner, TENANT, 'O1', 'RETURNED');
      expect(res.status).toBe('RETURNED');
      expect(inventory.adjustStock).toHaveBeenCalledTimes(2);
      expect(tx.cashFlow.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          tenantId: TENANT,
          flowType: 'EXPENSE',
          amount: 500000,
          description: 'Trả hàng đơn ORD1A2B3C',
        }),
      });
    });

    it.each([
      ['UTC028', 'PENDING', 'RETURNED'],
      ['UTC029', 'COMPLETED', 'CANCELLED'],
      ['UTC030', 'CANCELLED', 'COMPLETED'],
      ['UTC031', 'RETURNED', 'COMPLETED'],
    ])('%s: %s to %s is not an allowed transition', async (_id, from, to) => {
      given({ status: from });
      const run = service.updateStatus(owner, TENANT, 'O1', to);
      await expect(run).rejects.toThrow(ConflictException);
      await run.catch((error) => {
        expect(codeOf(error).code).toBe('ORDER_STATUS_TRANSITION_INVALID');
        expect(codeOf(error).message).toBe(
          `An order cannot move from ${from} to ${to}`,
        );
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('UTC032: unknown order id', async () => {
      prisma.order.findFirst.mockResolvedValue(null);
      const run = service.updateStatus(owner, TENANT, 'nope', 'COMPLETED');
      await expect(run).rejects.toThrow(NotFoundException);
      await run.catch((error) => {
        expect(codeOf(error).code).toBe('ORDER_NOT_FOUND');
        expect(codeOf(error).message).toBe('Order not found');
      });
    });

    it('UTC033: an order of another branch is refused for a branch-scoped cashier', async () => {
      given({ status: 'PENDING', branchId: 'BR-02' });
      const run = service.updateStatus(cashier, TENANT, 'O1', 'COMPLETED');
      await expect(run).rejects.toThrow(ForbiddenException);
      await run.catch((error) => {
        expect(codeOf(error).code).toBe('ORDER_BRANCH_DENIED');
        expect(codeOf(error).message).toBe(
          'This order does not belong to your branch',
        );
      });
    });

    it('UTC034: a concurrent status change applies no side effect', async () => {
      given({ status: 'PENDING' });
      tx.order.updateMany.mockResolvedValue({ count: 0 });
      const run = service.updateStatus(owner, TENANT, 'O1', 'CANCELLED');
      await expect(run).rejects.toThrow(ConflictException);
      await run.catch((error) => {
        expect(codeOf(error).code).toBe('ORDER_STATUS_CONFLICT');
        expect(codeOf(error).message).toBe(
          'The order status has just changed, please reload',
        );
      });
      expect(inventory.adjustStock).not.toHaveBeenCalled();
      expect(tx.cashFlow.create).not.toHaveBeenCalled();
    });
  });

  describe('payOffline', () => {
    const pending = { status: 'PENDING', paymentMethod: 'SEPAY' };
    const pay = (dto: Record<string, unknown> = {}) =>
      service.payOffline(owner, TENANT, 'O1', 'U2', dto as never);

    it('UTC035: without customerPay the order is settled in cash for exactly the total', async () => {
      given(pending, { ...pending, status: 'COMPLETED' });
      const res = await pay();
      expect(tx.order.updateMany).toHaveBeenCalledWith({
        where: { id: 'O1', status: 'PENDING', paymentMethod: 'SEPAY' },
        data: expect.objectContaining({
          status: 'COMPLETED',
          paymentMethod: 'CASH',
          customerPay: 200000,
          change: 0,
        }),
      });
      expect(flows).toHaveBeenCalledWith(tx, expect.anything(), 'CASH', 'U2');
      expect(realtime.emitToRoom).toHaveBeenCalledWith(
        `tenant:${TENANT}`,
        'order:paid',
        expect.objectContaining({ orderId: 'O1', paymentMethod: 'CASH' }),
      );
      expect(res.status).toBe('COMPLETED');
    });

    it('UTC036: an overpayment returns change', async () => {
      given(pending, pending);
      await pay({ customerPay: 250000, paymentMethod: 'CASH' });
      expect(tx.order.updateMany.mock.calls[0][0].data).toEqual(
        expect.objectContaining({ customerPay: 250000, change: 50000 }),
      );
    });

    it('UTC037: paying exactly the total gives no change', async () => {
      given(pending, pending);
      await pay({ customerPay: 200000 });
      expect(tx.order.updateMany.mock.calls[0][0].data.change).toBe(0);
    });

    it('UTC038: one dong short is refused', async () => {
      given(pending);
      const run = pay({ customerPay: 199999 });
      await expect(run).rejects.toThrow(BadRequestException);
      await run.catch((error) => {
        expect(codeOf(error).code).toBe('ORDER_CUSTOMER_PAY_TOO_LOW');
        expect(codeOf(error).message).toBe(
          'The customer paid 199999, which is less than the 200000 due',
        );
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('UTC039: an already completed order cannot be settled again', async () => {
      given({ status: 'COMPLETED', paymentMethod: 'SEPAY' });
      const run = pay();
      await expect(run).rejects.toThrow(ConflictException);
      await run.catch((error) => {
        expect(codeOf(error).code).toBe('ORDER_NOT_PENDING_SEPAY');
        expect(codeOf(error).message).toBe(
          'This order is no longer awaiting SePay payment',
        );
      });
    });

    it('UTC040: a pending cash order is not a SePay order', async () => {
      given({ status: 'PENDING', paymentMethod: 'CASH' });
      const run = pay();
      await expect(run).rejects.toThrow(ConflictException);
      await run.catch((error) => {
        expect(codeOf(error).code).toBe('ORDER_NOT_PENDING_SEPAY');
      });
    });

    it('UTC041: an order paid by the webhook meanwhile is refused', async () => {
      given(pending);
      tx.order.updateMany.mockResolvedValue({ count: 0 });
      const run = pay();
      await expect(run).rejects.toThrow(ConflictException);
      await run.catch((error) => {
        expect(codeOf(error).code).toBe('ORDER_PAYMENT_CONFLICT');
        expect(codeOf(error).message).toBe(
          'This order has just been paid or cancelled, please reload',
        );
      });
      expect(flows).not.toHaveBeenCalled();
    });
  });
});
