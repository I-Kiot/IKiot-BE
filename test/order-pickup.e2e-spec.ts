import 'dotenv/config';
import { randomUUID } from 'crypto';
import { Test } from '@nestjs/testing';
import { PrismaModule } from './../src/prisma/prisma.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { InventoryService } from './../src/modules/inventories/inventories.service';
import { InvoiceService } from './../src/modules/invoices/invoices.service';
import { NotificationService } from './../src/modules/notifications/notifications.service';
import { FulfillmentService } from './../src/modules/fulfillments/fulfillments.service';
import { ShipmentService } from './../src/modules/shipments/shipments.service';
import { ShipmentDeliveryService } from './../src/modules/shipments/shipment-delivery.service';
import { OrderService } from './../src/modules/orders/orders.service';
import { OrderPickupService } from './../src/modules/orders/order-pickup.service';
import { OrderCancelService } from './../src/modules/orders/order-cancel.service';
import {
  DeliveryCollectionMethod,
  PaymentKind,
  PaymentMethod,
  PaymentRecordStatus,
} from './../src/common/constants/payment-method';
import {
  FulfillmentType,
  OrderItemStatus,
  OrderPaymentStatus,
  OrderStatus,
  RemittanceStatus,
} from './../src/common/constants/order-status';
import {
  InventoryRefType,
  InventoryTxType,
  LotSourceType,
} from './../src/common/constants/inventory-ledger';
import { FulfillmentStatus } from './../src/common/constants/fulfillment-status';
import { CarrierType } from './../src/common/constants/shipment-status';
import { SystemRole } from './../src/common/constants/system-role';
import { ErrorCode } from './../src/common/errors/error-codes';
import type { AuthUser } from './../src/common/types/auth-user.type';

/**
 * Đơn khách tới lấy (STORE_PICKUP) trên Postgres thật: đóng gói xong thì chờ khách ở PACKED, thu số còn lại tại quầy
 * (tiền mặt hoặc QR), rồi giao hàng cho khách: trừ tồn, PACKED → COMPLETED, xuất hoá đơn. Không có shipment nào.
 * Tự tạo tenant riêng và dọn sạch.
 */
describe('Store pickup – POST /orders/:id/pickup/collect, /pickup/hand-over', () => {
  let prisma: PrismaService;
  let fulfillments: FulfillmentService;
  let shipments: ShipmentService;
  let delivery: ShipmentDeliveryService;
  let pickups: OrderPickupService;
  let cancels: OrderCancelService;
  let inventory: InventoryService;
  const notify = jest.fn();

  const tenantId = randomUUID();
  const ownerId = randomUUID();
  const assigneeId = randomUUID();
  const outsiderId = randomUUID();
  const branchId = randomUUID();
  const warehouseId = randomUUID();
  const productId = randomUUID();
  const tableId = randomUUID();
  const customerId = randomUUID();

  const owner = {
    userId: ownerId,
    tenantId,
    systemRole: SystemRole.TENANT_OWNER,
    permissions: new Set<string>(),
    branchId: null,
    warehouseId: null,
  } as unknown as AuthUser;

  /** Nhân viên không quyền, không phụ trách đơn. */
  const outsider = {
    ...owner,
    userId: outsiderId,
    systemRole: SystemRole.STAFF,
    warehouseId,
  } as unknown as AuthUser;

  /** Đơn khách tới lấy tổng 1000 × số lượng, cọc mặc định 300, đã đóng gói ở kho. */
  async function packedPickup(
    options: {
      fulfillmentType?: string;
      deposit?: number;
      pack?: boolean;
      requestedDeliveryDate?: Date;
    } = {},
  ) {
    const id = randomUUID();
    const deposit = options.deposit ?? 300;
    await prisma.order.create({
      data: {
        id,
        code: `PICK-${id}`,
        tenantId,
        branchId,
        customerId,
        userId: ownerId,
        assigneeId,
        status: OrderStatus.CONFIRMED,
        fulfillmentType:
          options.fulfillmentType ?? FulfillmentType.STORE_PICKUP,
        grandTotal: 1000,
        depositAmount: deposit,
        recipientName: 'Anh Nam',
        recipientPhone: '0912345678',
        requestedDeliveryDate: options.requestedDeliveryDate,
        items: {
          create: [
            {
              productItemId: tableId,
              sku: 'BAN-PICK',
              quantity: 1,
              listUnitPrice: 1000,
              unitPrice: 1000,
              lineTotal: 1000,
              sourceLocationId: warehouseId,
            },
          ],
        },
        payments:
          deposit > 0
            ? {
                create: {
                  tenantId,
                  kind: PaymentKind.DEPOSIT,
                  method: PaymentMethod.CASH,
                  amount: deposit,
                  status: PaymentRecordStatus.PAID,
                  paidAt: new Date(),
                },
              }
            : undefined,
      },
    });
    if (options.pack !== false) await fulfillments.packOrder(owner, id, {});
    return id;
  }

  const tableStock = () =>
    prisma.inventory.findFirstOrThrow({
      where: { tenantId, locationId: warehouseId, productItemId: tableId },
    });
  const orderOf = (id: string) =>
    prisma.order.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [
        InvoiceService,
        InventoryService,
        FulfillmentService,
        ShipmentService,
        ShipmentDeliveryService,
        OrderPickupService,
        OrderCancelService,
        {
          // Chỉ cần phạm vi chi nhánh và đọc lại đơn; phần còn lại của OrderService không dính tới luồng này.
          provide: OrderService,
          useValue: {
            branchScope: () => ({}),
            findOne: (_user: AuthUser, _tenant: string, id: string) =>
              prisma.order.findUniqueOrThrow({ where: { id } }),
          },
        },
        {
          provide: NotificationService,
          useValue: {
            managersOfLocation: () => Promise.resolve([]),
            tenantOwners: () => Promise.resolve([ownerId]),
            notify,
          },
        },
      ],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    fulfillments = moduleRef.get(FulfillmentService);
    shipments = moduleRef.get(ShipmentService);
    delivery = moduleRef.get(ShipmentDeliveryService);
    pickups = moduleRef.get(OrderPickupService);
    cancels = moduleRef.get(OrderCancelService);
    inventory = moduleRef.get(InventoryService);

    await prisma.tenant.create({
      data: {
        id: tenantId,
        name: 'pickup-e2e',
        bankingBankName: 'VCB',
        bankingAccountNumber: '0123456703',
        bankingAccountName: 'NOI THAT DEMO',
        bankingSepayLinkedAt: new Date(),
      },
    });
    await prisma.user.createMany({
      data: [ownerId, assigneeId, outsiderId].map((id) => ({
        id,
        tenantId,
        phoneNumber: `pick-${id}`,
        systemRole: id === ownerId ? SystemRole.TENANT_OWNER : SystemRole.STAFF,
      })),
    });
    await prisma.location.create({
      data: { id: branchId, tenantId, name: 'CN pickup', type: 'BRANCH' },
    });
    await prisma.branch.create({
      data: { id: branchId, tenantId, locationId: branchId },
    });
    await prisma.location.create({
      data: {
        id: warehouseId,
        tenantId,
        name: 'Kho pickup',
        type: 'WAREHOUSE',
      },
    });
    await prisma.product.create({
      data: { id: productId, tenantId, name: 'Nội thất' },
    });
    await prisma.productItem.create({
      data: {
        id: tableId,
        tenantId,
        productId,
        productName: 'Bàn',
        productCode: `PICK-${tableId}`,
        retailPrice: 1000,
        costPrice: 100,
      },
    });
    await prisma.customer.create({
      data: { id: customerId, tenantId, name: 'Khách' },
    });
    await prisma.$transaction((tx) =>
      inventory.openLot(tx, {
        tenantId,
        locationId: warehouseId,
        productItemId: tableId,
        quantity: 100,
        unitCost: 100,
        sourceType: LotSourceType.SUPPLIER,
        ledger: {
          type: InventoryTxType.IMPORT,
          referenceType: InventoryRefType.STOCK_MOVEMENT,
          referenceId: 'pickup-e2e',
        },
      }),
    );
  });

  afterAll(async () => {
    await prisma.shipment.deleteMany({ where: { tenantId } });
    await prisma.fulfillmentPackage.deleteMany({ where: { tenantId } });
    await prisma.fulfillmentItem.deleteMany({
      where: { fulfillment: { tenantId } },
    });
    await prisma.fulfillment.deleteMany({ where: { tenantId } });
    await prisma.inventoryTransaction.deleteMany({ where: { tenantId } });
    await prisma.inventoryLot.deleteMany({ where: { tenantId } });
    await prisma.payment.deleteMany({ where: { tenantId } });
    await prisma.invoice.deleteMany({ where: { tenantId } });
    await prisma.orderItem.deleteMany({ where: { order: { tenantId } } });
    await prisma.order.deleteMany({ where: { tenantId } });
    await prisma.inventory.deleteMany({ where: { tenantId } });
    await prisma.customer.deleteMany({ where: { tenantId } });
    await prisma.productItem.deleteMany({ where: { tenantId } });
    await prisma.product.deleteMany({ where: { tenantId } });
    await prisma.branch.deleteMany({ where: { tenantId } });
    await prisma.location.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.cashFlow.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
    await prisma.$disconnect();
  });

  beforeEach(() => notify.mockClear());

  describe('guards', () => {
    it('refuses a delivery order: only pickup is handed over at the counter', async () => {
      const id = await packedPickup({
        fulfillmentType: FulfillmentType.HOME_DELIVERY,
      });
      await expect(
        pickups.collect(owner, tenantId, id, {
          method: DeliveryCollectionMethod.CASH,
        }),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.ORDER_NOT_STORE_PICKUP },
      });
    });

    it('refuses an order that is not packed yet', async () => {
      const id = await packedPickup({ pack: false });
      await expect(
        pickups.handOver(owner, tenantId, id, {}),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.ORDER_PICKUP_NOT_READY },
      });
    });

    it('refuses someone who is neither the owner, the person in charge nor holding orders:ship', async () => {
      const id = await packedPickup();
      await expect(
        pickups.collect(outsider, tenantId, id, {
          method: DeliveryCollectionMethod.CASH,
        }),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.ORDER_STEP_DENIED },
      });
    });

    it('does not take a shipment for a pickup order', async () => {
      const id = await packedPickup();
      await expect(
        shipments.create(owner, tenantId, {
          orderId: id,
          carrierType: CarrierType.EXTERNAL,
          carrierName: 'GHN',
          trackingCode: `T-${id}`,
        }),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.SHIPMENT_NOT_FOR_PICKUP },
      });
    });
  });

  describe('cash at the counter', () => {
    it('will not hand over while money is still due', async () => {
      const id = await packedPickup();
      await expect(
        pickups.handOver(owner, tenantId, id, {}),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.ORDER_PICKUP_BALANCE_DUE },
      });
      expect((await orderOf(id)).status).toBe(OrderStatus.PACKED);
    });

    it('collects the balance, then hands over: stock out, completed, invoiced', async () => {
      const id = await packedPickup();
      const before = await tableStock();

      await pickups.collect(owner, tenantId, id, {
        method: DeliveryCollectionMethod.CASH,
      });
      const payment = await prisma.payment.findFirstOrThrow({
        where: { orderId: id, kind: PaymentKind.BALANCE },
      });
      expect(payment).toMatchObject({
        method: PaymentMethod.CASH,
        status: PaymentRecordStatus.PAID,
        remittanceStatus: RemittanceStatus.NOT_APPLICABLE,
      });
      expect(Number(payment.amount)).toBe(700);
      expect((await orderOf(id)).paymentStatus).toBe(OrderPaymentStatus.PAID);

      await pickups.handOver(owner, tenantId, id, {
        receiverName: 'Chị Lan',
        note: 'Nhận đủ 1 bàn',
      });

      const order = await orderOf(id);
      expect(order.status).toBe(OrderStatus.COMPLETED);
      expect(order.note).toContain('Chị Lan');
      const after = await tableStock();
      expect(after.stock).toBe(before.stock - 1);
      expect(after.lockedStock).toBe(before.lockedStock - 1);

      const sale = await prisma.inventoryTransaction.findMany({
        where: { tenantId, referenceId: id, type: InventoryTxType.SALE },
      });
      expect(sale).toHaveLength(1);
      expect(
        (
          await prisma.orderItem.findMany({
            where: { orderId: id },
            select: { status: true },
          })
        ).map((line) => line.status),
      ).toEqual([OrderItemStatus.SHIPPED]);
      expect(
        (await prisma.fulfillment.findFirstOrThrow({ where: { orderId: id } }))
          .status,
      ).toBe(FulfillmentStatus.HANDED_OVER);
      expect(await prisma.invoice.count({ where: { orderId: id } })).toBe(1);
      expect(await prisma.shipment.count({ where: { orderId: id } })).toBe(0);
    });

    it('hands over a fully deposited order with nothing to collect', async () => {
      const id = await packedPickup({ deposit: 1000 });
      await expect(
        pickups.collect(owner, tenantId, id, {
          method: DeliveryCollectionMethod.CASH,
        }),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.ORDER_COLLECTION_AMOUNT_MISMATCH },
      });
      await pickups.handOver(owner, tenantId, id, {});
      expect((await orderOf(id)).status).toBe(OrderStatus.COMPLETED);
    });

    it('cannot be handed over twice', async () => {
      const id = await packedPickup({ deposit: 1000 });
      await pickups.handOver(owner, tenantId, id, {});
      await expect(
        pickups.handOver(owner, tenantId, id, {}),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.ORDER_PICKUP_NOT_READY },
      });
    });
  });

  describe('QR at the counter', () => {
    it('waits for the transfer: the order stays packed until the money lands', async () => {
      const id = await packedPickup();
      const { payment } = await pickups.collect(owner, tenantId, id, {
        method: DeliveryCollectionMethod.BANK_TRANSFER_QR,
      });
      expect(payment).toMatchObject({ amount: 700, status: 'PENDING' });
      expect(payment?.qrUrl).toContain('amount=700');

      // Mã QR đang quét không đổi khi bấm lại.
      const again = await pickups.collect(owner, tenantId, id, {
        method: DeliveryCollectionMethod.BANK_TRANSFER_QR,
      });
      expect(again.payment?.reference).toBe(payment?.reference);

      await expect(
        pickups.handOver(owner, tenantId, id, {}),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.ORDER_PICKUP_BALANCE_DUE },
      });

      await delivery.settleSepayBalance(
        tenantId,
        payment!.reference,
        `tx-${id}`,
        700,
      );
      const settled = await orderOf(id);
      expect(settled.status).toBe(OrderStatus.PACKED);
      expect(settled.paymentStatus).toBe(OrderPaymentStatus.PAID);

      await pickups.handOver(owner, tenantId, id, {});
      expect((await orderOf(id)).status).toBe(OrderStatus.COMPLETED);
    });

    it('lets the customer pay cash instead: the waiting QR is cancelled', async () => {
      const id = await packedPickup();
      const { payment } = await pickups.collect(owner, tenantId, id, {
        method: DeliveryCollectionMethod.BANK_TRANSFER_QR,
      });
      await pickups.collect(owner, tenantId, id, {
        method: DeliveryCollectionMethod.CASH,
      });

      const rows = await prisma.payment.findMany({
        where: { orderId: id, kind: PaymentKind.BALANCE },
      });
      expect(
        rows.find((row) => row.paymentReference === payment!.reference)?.status,
      ).toBe(PaymentRecordStatus.CANCELLED);
      expect(
        rows.filter((row) => row.status === PaymentRecordStatus.PAID),
      ).toHaveLength(1);
    });
  });

  describe('cancelling a pickup order', () => {
    it('refunds the balance collected at the counter along with the deposit', async () => {
      const id = await packedPickup();
      await pickups.collect(owner, tenantId, id, {
        method: DeliveryCollectionMethod.CASH,
      });

      await expect(
        cancels.cancel(owner, tenantId, id, {}),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.ORDER_REFUND_AMOUNT_REQUIRED },
      });

      const { refund } = await cancels.cancel(owner, tenantId, id, {
        refundAmount: 1000,
      });
      expect(refund).toMatchObject({ held: 1000, refunded: 1000, kept: 0 });
      const order = await orderOf(id);
      expect(order.status).toBe(OrderStatus.CANCELLED);
      expect(order.paymentStatus).toBe(OrderPaymentStatus.REFUNDED);

      const flows = await prisma.cashFlow.findMany({
        where: { orderId: id },
        orderBy: { createdAt: 'asc' },
      });
      expect(flows.map((flow) => [flow.flowType, Number(flow.amount)])).toEqual(
        [
          ['INCOME', 700],
          ['EXPENSE', 1000],
        ],
      );
    });

    it('books nothing more when the shop keeps the money', async () => {
      const id = await packedPickup();
      await pickups.collect(owner, tenantId, id, {
        method: DeliveryCollectionMethod.CASH,
      });
      await cancels.cancel(owner, tenantId, id, { refundAmount: 0 });
      // Khách đã trả đủ và shop giữ cả: vẫn là đã thanh toán, không tụt về "đã cọc".
      expect((await orderOf(id)).paymentStatus).toBe(OrderPaymentStatus.PAID);
      expect(
        (await prisma.cashFlow.findMany({ where: { orderId: id } })).map(
          (flow) => flow.flowType,
        ),
      ).toEqual(['INCOME']);
    });

    it('books a QR transfer once, when the money lands', async () => {
      const id = await packedPickup();
      const { payment } = await pickups.collect(owner, tenantId, id, {
        method: DeliveryCollectionMethod.BANK_TRANSFER_QR,
      });
      expect(await prisma.cashFlow.count({ where: { orderId: id } })).toBe(0);

      for (let call = 0; call < 2; call += 1) {
        await delivery.settleSepayBalance(
          tenantId,
          payment!.reference,
          `tx-book-${id}`,
          700,
        );
      }
      const flows = await prisma.cashFlow.findMany({ where: { orderId: id } });
      expect(flows).toHaveLength(1);
      expect(flows[0]).toMatchObject({
        flowType: 'INCOME',
        paymentMethod: PaymentMethod.SEPAY,
        paymentReference: payment!.reference,
      });
    });

    it('voids a QR still waiting, so a late transfer is not booked as collected', async () => {
      const id = await packedPickup();
      const { payment } = await pickups.collect(owner, tenantId, id, {
        method: DeliveryCollectionMethod.BANK_TRANSFER_QR,
      });

      await cancels.cancel(owner, tenantId, id, { refundAmount: 300 });
      expect(
        (
          await prisma.payment.findFirstOrThrow({
            where: { paymentReference: payment!.reference },
          })
        ).status,
      ).toBe(PaymentRecordStatus.CANCELLED);

      await delivery.settleSepayBalance(
        tenantId,
        payment!.reference,
        `late-${id}`,
        700,
      );
      expect(
        (
          await prisma.payment.findFirstOrThrow({
            where: { paymentReference: payment!.reference },
          })
        ).status,
      ).toBe(PaymentRecordStatus.CANCELLED);
    });
  });
});
