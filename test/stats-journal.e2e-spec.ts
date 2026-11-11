import 'dotenv/config';
import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { InventoryService } from './../src/modules/inventories/inventories.service';
import { OrderService } from './../src/modules/orders/orders.service';
import { StatsService } from './../src/modules/stats/stats.service';
import { StatsReportsService } from './../src/modules/stats/stats-reports.service';
import {
  RevenueByStaffQueryDto,
  RevenueSeriesQueryDto,
  SalesJournalQueryDto,
  StatsQueryDto,
} from './../src/modules/stats/dto/stats-query.dto';
import { vietnamDateOf } from './../src/modules/stats/stats-math';
import { NotificationService } from './../src/modules/notifications/notifications.service';
import { RealtimeGateway } from './../src/common/realtime/realtime.gateway';
import {
  FulfillmentType,
  OrderStatus,
} from './../src/common/constants/order-status';
import {
  InventoryRefType,
  InventoryTxType,
  LotSourceType,
} from './../src/common/constants/inventory-ledger';
import { SystemRole } from './../src/common/constants/system-role';
import type { AuthUser } from './../src/common/types/auth-user.type';
import { deleteTenantMoneyTrail } from './helpers/cleanup-money';

/** Dựng một DTO query như class-transformer sẽ làm từ query string. */
function query<T extends StatsQueryDto>(Dto: new () => T, input: object): T {
  return Object.assign(new Dto(), input);
}

/**
 * Phase 8 (Postgres thật): thống kê đọc từ sổ doanh thu và sổ thu chi.
 * Kịch bản chính: bán ở tháng 9, trả hàng ở tháng 10 -> tháng 9 giữ nguyên, tháng 10 âm đúng phần trả.
 */
describe('stats on the sales journal + reconciliation reports', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let stats: StatsService;
  let reports: StatsReportsService;
  let orders: OrderService;
  let inventory: InventoryService;

  const tenantId = randomUUID();
  const ownerId = randomUUID();
  const driverId = randomUUID();
  const branchId = randomUUID();
  const warehouseId = randomUUID();
  const productId = randomUUID();
  const itemId = randomUUID();
  const customerId = randomUUID();

  const owner = {
    tenantId,
    roleId: null,
    shiftSupervision: null,
    email: null,
    displayName: 'x',
    userId: ownerId,
    systemRole: SystemRole.TENANT_OWNER,
    permissions: new Set<string>(),
    branchId: null,
    warehouseId: null,
    phoneNumber: `sj-${ownerId}`,
  } as unknown as AuthUser;

  const sep = { fromDate: '2026-09-01', toDate: '2026-09-30' };
  const oct = { fromDate: '2026-10-01', toDate: '2026-10-31' };

  async function orderRow(
    over: Record<string, unknown> = {},
    amount = 1000,
    quantity = 1,
  ) {
    const id = randomUUID();
    await prisma.order.create({
      data: {
        id,
        code: `SJ-${id}`,
        tenantId,
        branchId,
        customerId,
        userId: ownerId,
        assigneeId: driverId,
        status: OrderStatus.CONFIRMED,
        fulfillmentType: FulfillmentType.HOME_DELIVERY,
        grandTotal: amount,
        depositAmount: 0,
        recipientName: 'Khách',
        recipientPhone: '0912345678',
        deliveryAddress: '1 Cầu Giấy',
        items: {
          create: [
            {
              productItemId: itemId,
              sku: 'SJ',
              productName: 'Bàn',
              quantity,
              listUnitPrice: amount / quantity,
              unitPrice: amount / quantity,
              lineTotal: amount,
              sourceLocationId: warehouseId,
            },
          ],
        },
        ...over,
      },
    });
    const line = await prisma.orderItem.findFirstOrThrow({
      where: { orderId: id },
    });
    return { id, lineId: line.id };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    stats = app.get(StatsService);
    reports = app.get(StatsReportsService);
    orders = app.get(OrderService);
    inventory = app.get(InventoryService);
    jest
      .spyOn(app.get(NotificationService), 'notify')
      .mockResolvedValue({ notified: 0 });
    jest
      .spyOn(app.get(RealtimeGateway), 'emitToRoom')
      .mockImplementation(jest.fn());

    await prisma.tenant.create({
      data: { id: tenantId, name: 'stats-journal' },
    });
    await prisma.user.createMany({
      data: [ownerId, driverId].map((id) => ({
        id,
        tenantId,
        phoneNumber: `sj-${id}`,
        systemRole: id === ownerId ? SystemRole.TENANT_OWNER : SystemRole.STAFF,
        profileFirstName: id === driverId ? 'Tài' : 'Chủ',
        profileLastName: 'Xế',
      })),
    });
    for (const [id, type, name] of [
      [branchId, 'BRANCH', 'CN sj'],
      [warehouseId, 'WAREHOUSE', 'Kho sj'],
    ]) {
      await prisma.location.create({ data: { id, tenantId, name, type } });
    }
    await prisma.branch.create({
      data: { id: branchId, tenantId, locationId: branchId },
    });
    await prisma.product.create({
      data: { id: productId, tenantId, name: 'Nội thất' },
    });
    await prisma.productItem.create({
      data: {
        id: itemId,
        tenantId,
        productId,
        productName: 'Bàn',
        productCode: `SJ-${itemId}`,
        retailPrice: 1000,
        costPrice: 1, // cố ý lệch giá lô: giá trị tồn phải đọc từ lô
      },
    });
    await prisma.customer.create({
      data: { id: customerId, tenantId, name: 'Khách' },
    });
    for (const locationId of [branchId, warehouseId]) {
      await prisma.$transaction((tx) =>
        inventory.openLot(tx, {
          tenantId,
          locationId,
          productItemId: itemId,
          quantity: 10,
          unitCost: 100,
          sourceType: LotSourceType.SUPPLIER,
          ledger: {
            type: InventoryTxType.IMPORT,
            referenceType: InventoryRefType.STOCK_MOVEMENT,
            referenceId: 'stats-journal-e2e',
          },
        }),
      );
    }
  });

  afterAll(async () => {
    await deleteTenantMoneyTrail(prisma, tenantId);
    await prisma.payment.deleteMany({
      where: { tenantId, refundOfPaymentId: { not: null } },
    });
    await prisma.payment.deleteMany({ where: { tenantId } });
    await prisma.invoice.deleteMany({ where: { tenantId } });
    await prisma.inventoryTransaction.deleteMany({ where: { tenantId } });
    await prisma.inventoryLot.deleteMany({ where: { tenantId } });
    await prisma.orderItem.deleteMany({ where: { order: { tenantId } } });
    await prisma.order.deleteMany({ where: { tenantId } });
    await prisma.inventory.deleteMany({ where: { tenantId } });
    await prisma.customer.deleteMany({ where: { tenantId } });
    await prisma.productItem.deleteMany({ where: { tenantId } });
    await prisma.product.deleteMany({ where: { tenantId } });
    await prisma.branch.deleteMany({ where: { tenantId } });
    await prisma.location.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
    await app.close();
  });

  describe('sold in September, returned in October', () => {
    let orderId: string;

    beforeAll(async () => {
      const o = await orderRow(
        {
          status: OrderStatus.COMPLETED,
          completedAt: new Date('2026-09-10T05:00:00Z'),
        },
        1000,
        2,
      );
      orderId = o.id;
      await prisma.salesJournalEntry.create({
        data: {
          tenantId,
          branchId,
          orderId,
          entryType: 'SALE',
          businessDate: new Date('2026-09-10'),
          goodsAmount: 800,
          shippingAmount: 200,
          totalAmount: 1000,
          cogsAmount: 500,
          shippingCost: 50,
          channelFee: 0,
          customerId,
          assigneeId: driverId,
          creatorId: ownerId,
          source: 'DELIVERY',
          lines: {
            create: [
              {
                orderItemId: o.lineId,
                productItemId: itemId,
                quantity: 2,
                amount: 800,
                cogs: 500,
              },
            ],
          },
        },
      });
      // Đơn COMPLETED cũ không có bút toán (trước migration sổ): báo cáo không được lỗi mà phải nói rõ phần thiếu.
      await orderRow({
        status: OrderStatus.COMPLETED,
        completedAt: new Date('2026-09-12T05:00:00Z'),
      });
    });

    it('September shows the sale; October (before the return is posted) is empty', async () => {
      const september = await stats.getOverview(
        user(),
        query(StatsQueryDto, sep),
      );
      expect(september.revenue).toBe(1000);
      expect(september.grossSales).toBe(1000);
      expect(september.returns).toBe(0);
      expect(september.orderCount).toBe(1);
      expect(september.costOfGoods).toBe(500);
      expect(september.shippingCost).toBe(50);
      // doanh thu - giá vốn thực - chi phí vận chuyển thực
      expect(september.grossProfit).toBe(450);
      // đơn hoàn thành tháng 9 nhưng không có bút toán: được báo, không làm hỏng báo cáo
      expect(september.journalGap.ordersWithoutJournal).toBe(1);
      const october = await stats.getOverview(
        user(),
        query(StatsQueryDto, oct),
      );
      expect(october.revenue).toBe(0);
      expect(october.returnCount).toBe(0);
    });

    it('the return lands in October as a negative; September does not change', async () => {
      const line = await prisma.orderItem.findFirstOrThrow({
        where: { orderId },
      });
      await prisma.salesJournalEntry.create({
        data: {
          tenantId,
          branchId,
          orderId,
          entryType: 'RETURN',
          businessDate: new Date('2026-10-05'),
          goodsAmount: -400,
          totalAmount: -400,
          cogsAmount: -250,
          customerId,
          assigneeId: driverId,
          creatorId: ownerId,
          source: 'RETURN_INSPECTION',
          lines: {
            create: [
              {
                orderItemId: line.id,
                productItemId: itemId,
                quantity: -1,
                amount: -400,
                cogs: -250,
              },
            ],
          },
        },
      });

      const october = await stats.getOverview(
        user(),
        query(StatsQueryDto, oct),
      );
      expect(october.revenue).toBe(-400);
      expect(october.returns).toBe(-400);
      expect(october.grossSales).toBe(0);
      expect(october.orderCount).toBe(0);
      expect(october.returnCount).toBe(1);
      // giá vốn của hàng trở về kho là số âm: lợi nhuận tháng 10 = -400 + 250
      expect(october.costOfGoods).toBe(-250);
      expect(october.grossProfit).toBe(-150);

      const september = await stats.getOverview(
        user(),
        query(StatsQueryDto, sep),
      );
      expect(september.revenue).toBe(1000);
      expect(september.returns).toBe(0);
      expect(september.grossProfit).toBe(450);
    });

    it('the monthly series, products and staff agree with the journal', async () => {
      const series = await stats.getRevenueSeries(
        user(),
        query(RevenueSeriesQueryDto, {
          fromDate: '2026-09-01',
          toDate: '2026-10-31',
          groupBy: 'month',
        }),
      );
      expect(series.series).toEqual([
        { bucket: '2026-09', revenue: 1000, returns: 0, orderCount: 1 },
        { bucket: '2026-10', revenue: -400, returns: -400, orderCount: 0 },
      ]);

      const top = await stats.getTopProducts(
        user(),
        Object.assign(
          query(StatsQueryDto, {
            fromDate: '2026-09-01',
            toDate: '2026-10-31',
          }),
          { sortBy: 'quantity', limit: 5 },
        ),
      );
      expect(top.products).toEqual([
        {
          productItemId: itemId,
          productName: 'Bàn',
          quantity: 1, // 2 bán - 1 trả
          revenue: 400,
        },
      ]);

      const byAssignee = await stats.getRevenueByStaff(
        user(),
        query(RevenueByStaffQueryDto, {
          fromDate: '2026-09-01',
          toDate: '2026-10-31',
          groupBy: 'assignee',
        }),
      );
      expect(byAssignee.staff).toEqual([
        {
          userId: driverId,
          staffName: 'Tài Xế',
          revenue: 600,
          orderCount: 1,
          aov: 600,
        },
      ]);
    });

    it('the journal route lists entries with lines and totals, filtered by type', async () => {
      const all = await reports.getSalesJournal(
        user(),
        query(SalesJournalQueryDto, {
          fromDate: '2026-09-01',
          toDate: '2026-10-31',
          page: 1,
          limit: 20,
        }),
      );
      expect(all.data.map((e) => [e.entryType, e.businessDate])).toEqual([
        ['RETURN', '2026-10-05'],
        ['SALE', '2026-09-10'],
      ]);
      expect(all.data[1].lines[0]).toMatchObject({
        quantity: 2,
        amount: 800,
        cogs: 500,
        productName: 'Bàn',
      });
      expect(all.totals.totalAmount).toBe(600);
      expect(all.totals.cogsAmount).toBe(250);
      const onlyReturns = await reports.getSalesJournal(
        user(),
        query(SalesJournalQueryDto, {
          fromDate: '2026-09-01',
          toDate: '2026-10-31',
          entryType: 'RETURN',
          page: 1,
          limit: 20,
        }),
      );
      expect(onlyReturns.data).toHaveLength(1);
    });
  });

  describe('cash basis by payment method / fund / category, and the real writers', () => {
    const today = vietnamDateOf(new Date());
    const day = { fromDate: today, toDate: today };

    it('a till sale feeds the journal (today) and the cash book', async () => {
      await orders.createPosSale(owner, tenantId, {
        branchId,
        paymentMethod: 'CASH',
        customerPay: 1500,
        items: [{ productItemId: itemId, quantity: 1 }],
      });
      await orders.createPosSale(owner, tenantId, {
        branchId,
        paymentMethod: 'BANK_TRANSFER',
        items: [{ productItemId: itemId, quantity: 1 }],
      });

      const overview = await stats.getOverview(
        user(),
        query(StatsQueryDto, day),
      );
      expect(overview.orderCount).toBe(2);
      expect(overview.revenue).toBe(2000);
      expect(overview.costOfGoods).toBe(200);
      expect(overview.linesMissingCost).toBe(0);

      const methods = await stats.getRevenueByPaymentMethod(
        user(),
        query(StatsQueryDto, day),
      );
      const cash = methods.breakdown.find((m) => m.paymentMethod === 'CASH');
      // tiền mặt thực giữ = 1500 khách đưa - 500 thối
      expect(cash).toMatchObject({
        received: 1500,
        change: 500,
        refunded: 0,
        revenue: 1000,
        orderCount: 1,
      });
      expect(
        methods.breakdown.find((m) => m.paymentMethod === 'BANK_TRANSFER'),
      ).toMatchObject({ revenue: 1000, received: 1000 });

      const flow = await stats.getCashflow(user(), query(StatsQueryDto, day));
      expect(flow.byFund).toEqual(
        expect.arrayContaining([
          { fund: 'DRAWER', income: 1500, expense: 500, count: 2, net: 1000 },
          { fund: 'BANK', income: 1000, expense: 0, count: 1, net: 1000 },
        ]),
      );
      expect(flow.byCategory.map((c) => [c.category, c.fund, c.total])).toEqual(
        expect.arrayContaining([
          ['ORDER_PAYMENT', 'DRAWER', 1500],
          ['SALE_CHANGE', 'DRAWER', 500],
          ['ORDER_PAYMENT', 'BANK', 1000],
        ]),
      );

      const list = await stats.getCashflowList(
        user(),
        Object.assign(query(StatsQueryDto, day), {
          category: 'SALE_CHANGE',
          page: 1,
          limit: 10,
        }),
      );
      expect(list.data).toHaveLength(1);
      expect(list.data[0]).toMatchObject({
        category: 'SALE_CHANGE',
        fund: 'DRAWER',
        amount: 500,
      });
    });

    it('stock value comes from the lots, not the catalogue cost', async () => {
      const inv = await stats.getInventory(user(), {
        lowStockThreshold: 10,
      });
      // 2 kho x 10 cái, trừ 2 cái bán ở quầy -> 18 cái x 100 (giá lô); giá danh mục là 1
      expect(inv.stockValue).toBe(1800);
    });
  });

  describe('unreconciled report', () => {
    it('lists shipper cash, SePay exceptions, overpaid orders, owner fund, warehouse counter cash and cash refunds out of a drawer', async () => {
      // 1. Tiền mặt shipper đang giữ.
      const held = await orderRow({ status: OrderStatus.CONFIRMED }, 700);
      await prisma.payment.create({
        data: {
          tenantId,
          orderId: held.id,
          method: 'CASH',
          kind: 'BALANCE',
          status: 'PAID',
          amount: 700,
          paidAt: new Date(Date.now() - 86_400_000),
          collectedById: driverId,
          remittanceStatus: 'PENDING',
          locationId: warehouseId,
        },
      });
      // 2. Giao dịch SePay chưa gắn được đơn.
      await prisma.sepayTransaction.create({
        data: {
          tenantId,
          dedupeKey: `sj-${randomUUID()}`,
          amount: 500,
          outcome: 'UNMATCHED',
          rejectReason: 'NO_REFERENCE',
        },
      });
      // 3. Đơn trả dư.
      const over = await orderRow({ status: OrderStatus.CONFIRMED }, 1000);
      await prisma.payment.create({
        data: {
          tenantId,
          orderId: over.id,
          method: 'BANK_TRANSFER',
          kind: 'FULL',
          status: 'PAID',
          amount: 1300,
        },
      });
      // 4. Tiền mặt shipper đã nộp chủ (OWNER) rồi hoàn tiền mặt từ két chi nhánh.
      const refunded = await orderRow({ status: OrderStatus.RETURNED }, 600);
      const paid = await prisma.payment.create({
        data: {
          tenantId,
          orderId: refunded.id,
          method: 'CASH',
          kind: 'BALANCE',
          status: 'PAID',
          amount: 600,
          remittanceStatus: 'RECEIVED',
        },
      });
      await prisma.cashFlow.create({
        data: {
          tenantId,
          flowType: 'INCOME',
          amount: 600,
          paymentMethod: 'CASH',
          category: 'ORDER_PAYMENT',
          fund: 'OWNER',
          locationId: branchId,
          orderId: refunded.id,
          paymentId: paid.id,
        },
      });
      const refund = await prisma.payment.create({
        data: {
          tenantId,
          orderId: refunded.id,
          method: 'CASH',
          kind: 'REFUND',
          status: 'PAID',
          amount: 300,
          refundOfPaymentId: paid.id,
        },
      });
      await prisma.cashFlow.create({
        data: {
          tenantId,
          flowType: 'EXPENSE',
          amount: 300,
          paymentMethod: 'CASH',
          category: 'ORDER_REFUND',
          fund: 'DRAWER',
          locationId: branchId,
          orderId: refunded.id,
          paymentId: refund.id,
        },
      });
      // 5. Tiền mặt thu tại quầy kho (không có két).
      const counter = await orderRow({ status: OrderStatus.CONFIRMED }, 400);
      const counterPay = await prisma.payment.create({
        data: {
          tenantId,
          orderId: counter.id,
          method: 'CASH',
          kind: 'FULL',
          status: 'PAID',
          amount: 400,
          locationId: warehouseId,
        },
      });
      await prisma.cashFlow.create({
        data: {
          tenantId,
          flowType: 'INCOME',
          amount: 400,
          paymentMethod: 'CASH',
          category: 'ORDER_PAYMENT',
          fund: 'DRAWER',
          locationId: warehouseId,
          orderId: counter.id,
          paymentId: counterPay.id,
        },
      });

      const report = await reports.getUnreconciled(user());
      expect(report.scope).toBe('TENANT');
      expect(report.shipperCash.amount).toBe(700);
      expect(report.shipperCash.items[0]).toMatchObject({
        collectorId: driverId,
        collectorName: 'Tài Xế',
        orderCount: 1,
        amount: 700,
      });
      expect(report.sepayExceptions.count).toBe(1);
      expect(report.sepayExceptions.amount).toBe(500);
      expect(report.overpaidOrders.items.map((o) => o.orderId)).toContain(
        over.id,
      );
      expect(
        report.overpaidOrders.items.find((o) => o.orderId === over.id)
          ?.overpaidBy,
      ).toBe(300);
      expect(report.ownerFund).toMatchObject({
        income: 600,
        expense: 0,
        balance: 600,
      });
      expect(report.warehouseCounterCash.net).toBe(400);
      expect(report.cashRefundsAgainstDrawer).toMatchObject({
        count: 1,
        amount: 300,
      });
      expect(report.cashRefundsAgainstDrawer.items[0].locationId).toBe(
        branchId,
      );
      expect(report.unallocatedBank).toEqual({
        receipts: 0,
        refunds: 0,
        net: 0,
      });
      // Đơn COMPLETED cũ (tháng 9) không có bút toán; hai đơn quầy hôm nay có sổ nên không tính
      expect(report.journalCoverage.ordersWithoutJournal).toBe(1);
      expect(report.journalCoverage.firstJournalAt).not.toBeNull();
    });
  });

  /** Chủ shop (toàn tenant). */
  function user(): AuthUser {
    return owner;
  }
});
