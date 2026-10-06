import 'dotenv/config';
import { randomUUID } from 'crypto';
import { Test } from '@nestjs/testing';
import { PrismaModule } from './../src/prisma/prisma.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { OrderService } from './../src/modules/orders/orders.service';
import { OrderPricingService } from './../src/modules/orders/order-pricing.service';
import { ManualOrderService } from './../src/modules/orders/manual-order.service';
import { OrderCustomizationService } from './../src/modules/orders/order-customization.service';
import { OrderShortageAlerts } from './../src/modules/orders/order-shortage-alerts';
import { ProductionListService } from './../src/modules/production-requests/production-list.service';
import { OrderReadService } from './../src/modules/orders/order-read.service';
import { OrderRemittanceService } from './../src/modules/orders/order-remittance.service';
import { SepayOrderService } from './../src/modules/orders/sepay-order.service';
import { CustomerService } from './../src/modules/customers/customers.service';
import { InventoryService } from './../src/modules/inventories/inventories.service';
import { FulfillmentService } from './../src/modules/fulfillments/fulfillments.service';
import { ShipmentService } from './../src/modules/shipments/shipments.service';
import { ShipmentDeliveryService } from './../src/modules/shipments/shipment-delivery.service';
import { NotificationService } from './../src/modules/notifications/notifications.service';
import { PromotionService } from './../src/modules/promotions/promotions.service';
import { RealtimeGateway } from './../src/common/realtime/realtime.gateway';
import {
  InventoryRefType,
  InventoryTxType,
  LotSourceType,
} from './../src/common/constants/inventory-ledger';
import {
  OrderStatus,
  RemittanceStatus,
} from './../src/common/constants/order-status';
import {
  DeliveryCollectionMethod,
  PaymentKind,
} from './../src/common/constants/payment-method';
import { CarrierType } from './../src/common/constants/shipment-status';
import { SystemRole } from './../src/common/constants/system-role';
import { UserStatus } from './../src/common/constants/user-status';
import { ErrorCode } from './../src/common/errors/error-codes';
import type { AuthUser } from './../src/common/types/auth-user.type';

/**
 * Chủ xác nhận đã nhận tiền mặt từ shipper (A-10, OrderRemittanceService – `POST
 * /orders/:id/confirm-remittance`) trên Postgres thật (docker compose up -d). Đơn đi đủ luồng thật:
 * tạo (có cọc) → đóng gói → lấy hàng → đang vận chuyển → giao thu tiền mặt (C-5), rồi mới xác nhận.
 * Tự tạo tenant riêng và dọn sạch.
 */
describe('POST /orders/:id/confirm-remittance – OrderRemittanceService', () => {
  let prisma: PrismaService;
  let manual: ManualOrderService;
  let remittances: OrderRemittanceService;
  let fulfillments: FulfillmentService;
  let shipments: ShipmentService;
  let delivery: ShipmentDeliveryService;

  const tenantId = randomUUID();
  const ownerId = randomUUID();
  const branchId = randomUUID();
  const otherBranchId = randomUUID();
  const warehouseId = randomUUID();
  const productId = randomUUID();
  const sofaId = randomUUID();
  const customerId = randomUUID();

  const owner = {
    userId: ownerId,
    tenantId,
    systemRole: SystemRole.TENANT_OWNER,
    permissions: new Set<string>(),
    branchId: null,
    warehouseId: null,
  } as unknown as AuthUser;

  const proof = ['https://cdn.example.com/giao-hang.jpg'];

  const codeOf = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      return (error as { getResponse(): { code: string } }).getResponse().code;
    }
    return undefined;
  };

  const confirm = (orderId: string, amount: number, note?: string) =>
    remittances.confirm(owner, tenantId, orderId, { amount, note });

  /** An order of one sofa (10.000.000đ) with a 3.000.000đ deposit, taken to SHIPPING through the real routes. */
  const shippingOrder = async () => {
    const { id } = await manual.create(owner, tenantId, {
      branchId,
      customerId,
      assigneeId: ownerId,
      fulfillmentType: 'HOME_DELIVERY',
      items: [{ productItemId: sofaId, quantity: 1 }],
      deposit: { type: 'AMOUNT', value: 3_000_000, method: 'CASH' },
    });
    await fulfillments.packOrder(owner, id, {});
    const shipment = await shipments.create(owner, tenantId, {
      orderId: id,
      carrierType: CarrierType.INTERNAL,
      driverId: ownerId,
    });
    await shipments.shipOrder(owner, tenantId, id, {});
    return { orderId: id, shipmentId: shipment.id };
  };

  /** Delivered, the remaining 7.000.000đ collected by `method`. */
  const deliveredOrder = async (method: string) => {
    const { orderId, shipmentId } = await shippingOrder();
    await delivery.deliver(owner, tenantId, shipmentId, {
      proofPhotoUrls: proof,
      paymentMethod: method,
      collectedAmount: 7_000_000,
    });
    return orderId;
  };

  const orderOf = (id: string) =>
    prisma.order.findUniqueOrThrow({
      where: { id },
      include: { payments: { where: { kind: PaymentKind.BALANCE } } },
    });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [
        OrderService,
        OrderPricingService,
        ManualOrderService,
        OrderCustomizationService,
        OrderShortageAlerts,
        ProductionListService,
        OrderReadService,
        OrderRemittanceService,
        CustomerService,
        InventoryService,
        FulfillmentService,
        ShipmentService,
        ShipmentDeliveryService,
        {
          provide: NotificationService,
          useValue: {
            managersOfLocation: () => Promise.resolve([]),
            tenantOwners: () => Promise.resolve([ownerId]),
            notify: jest.fn(),
          },
        },
        { provide: RealtimeGateway, useValue: {} },
        { provide: SepayOrderService, useValue: {} },
        { provide: PromotionService, useValue: {} },
      ],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    manual = moduleRef.get(ManualOrderService);
    remittances = moduleRef.get(OrderRemittanceService);
    fulfillments = moduleRef.get(FulfillmentService);
    shipments = moduleRef.get(ShipmentService);
    delivery = moduleRef.get(ShipmentDeliveryService);
    const inventory = moduleRef.get(InventoryService);

    // A bank account, so a delivery can be paid by QR.
    await prisma.tenant.create({
      data: {
        id: tenantId,
        name: 'remit-e2e',
        bankingBankName: 'VCB',
        bankingAccountNumber: '0123456789',
        bankingAccountName: 'NOI THAT DEMO',
      },
    });
    await prisma.user.create({
      data: {
        id: ownerId,
        tenantId,
        phoneNumber: `remit-${ownerId}`,
        systemRole: SystemRole.TENANT_OWNER,
        status: UserStatus.ACTIVE,
      },
    });
    await prisma.location.create({
      data: { id: warehouseId, tenantId, name: 'Kho', type: 'WAREHOUSE' },
    });
    await prisma.warehouse.create({
      data: { id: warehouseId, tenantId, locationId: warehouseId },
    });
    for (const id of [branchId, otherBranchId]) {
      await prisma.location.create({
        data: {
          id,
          tenantId,
          name: `CN ${id.slice(0, 4)}`,
          type: 'BRANCH',
          defaultFulfillmentLocationId: warehouseId,
        },
      });
      await prisma.branch.create({ data: { id, tenantId, locationId: id } });
    }
    await prisma.product.create({
      data: { id: productId, tenantId, name: 'Nội thất' },
    });
    await prisma.productItem.create({
      data: {
        id: sofaId,
        tenantId,
        productId,
        productName: 'Sofa',
        productCode: `REMIT-${sofaId}`,
        sku: `REMIT-${sofaId.slice(0, 8)}`,
        retailPrice: 10_000_000,
        costPrice: 6_000_000,
      },
    });
    await prisma.customer.create({
      data: { id: customerId, tenantId, name: 'Khách' },
    });
    await prisma.$transaction((tx) =>
      inventory.openLot(tx, {
        tenantId,
        locationId: warehouseId,
        productItemId: sofaId,
        quantity: 20,
        unitCost: 6_000_000,
        sourceType: LotSourceType.SUPPLIER,
        ledger: {
          type: InventoryTxType.IMPORT,
          referenceType: InventoryRefType.STOCK_MOVEMENT,
          referenceId: 'remit-e2e',
        },
      }),
    );
  });

  afterAll(async () => {
    await prisma.shipmentEvent.deleteMany({
      where: { shipment: { tenantId } },
    });
    await prisma.shipment.deleteMany({ where: { tenantId } });
    await prisma.fulfillmentPackage.deleteMany({ where: { tenantId } });
    await prisma.fulfillmentItem.deleteMany({
      where: { fulfillment: { tenantId } },
    });
    await prisma.fulfillment.deleteMany({ where: { tenantId } });
    await prisma.payment.deleteMany({ where: { tenantId } });
    await prisma.inventoryTransaction.deleteMany({ where: { tenantId } });
    await prisma.inventoryLot.deleteMany({ where: { tenantId } });
    await prisma.orderItem.deleteMany({ where: { order: { tenantId } } });
    await prisma.order.deleteMany({ where: { tenantId } });
    await prisma.inventory.deleteMany({ where: { tenantId } });
    await prisma.customer.deleteMany({ where: { tenantId } });
    await prisma.productItem.deleteMany({ where: { tenantId } });
    await prisma.product.deleteMany({ where: { tenantId } });
    await prisma.branch.deleteMany({ where: { tenantId } });
    await prisma.warehouse.deleteMany({ where: { tenantId } });
    await prisma.location.updateMany({
      where: { tenantId },
      data: { defaultFulfillmentLocationId: null },
    });
    await prisma.location.deleteMany({ where: { tenantId } });
    await prisma.notification.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
    await prisma.$disconnect();
  });

  it('completes a cash delivery once the owner has all of it, recording who and when', async () => {
    const orderId = await deliveredOrder(DeliveryCollectionMethod.CASH);
    const before = await orderOf(orderId);
    expect(before.status).toBe(OrderStatus.RECEIVED);
    expect(before.payments[0].remittanceStatus).toBe(RemittanceStatus.PENDING);

    const detail = await confirm(orderId, 7_000_000, 'Đã đếm đủ');

    const after = await orderOf(orderId);
    expect(after.status).toBe(OrderStatus.COMPLETED);
    const [cash] = after.payments;
    expect(cash.remittanceStatus).toBe(RemittanceStatus.RECEIVED);
    expect(cash.remittanceConfirmedById).toBe(ownerId);
    expect(cash.remittanceConfirmedAt).not.toBeNull();
    expect(cash.note).toContain('Đã đếm đủ');
    expect(detail).toMatchObject({ id: orderId });
  });

  it('refuses a hand-over that is not the full amount, and changes nothing', async () => {
    const orderId = await deliveredOrder(DeliveryCollectionMethod.CASH);
    let body: { code?: string; remittance?: unknown } = {};
    try {
      await confirm(orderId, 6_500_000);
    } catch (error) {
      body = (error as { getResponse(): typeof body }).getResponse();
    }
    expect(body.code).toBe(ErrorCode.ORDER_REMITTANCE_AMOUNT_MISMATCH);
    expect(body.remittance).toEqual({
      held: 7_000_000,
      amount: 6_500_000,
      difference: -500_000,
    });

    const after = await orderOf(orderId);
    expect(after.status).toBe(OrderStatus.RECEIVED);
    expect(after.payments[0].remittanceStatus).toBe(RemittanceStatus.PENDING);
  });

  it('settles a cash hand-over only once', async () => {
    const orderId = await deliveredOrder(DeliveryCollectionMethod.CASH);
    await confirm(orderId, 7_000_000);
    expect(await codeOf(confirm(orderId, 7_000_000))).toBe(
      ErrorCode.ORDER_REMITTANCE_NOT_PENDING,
    );
  });

  it('has nothing to confirm for a QR delivery waiting on the bank, or an order still on its way', async () => {
    const qrOrder = await deliveredOrder(
      DeliveryCollectionMethod.BANK_TRANSFER_QR,
    );
    expect((await orderOf(qrOrder)).status).toBe(OrderStatus.RECEIVED);
    expect(await codeOf(confirm(qrOrder, 7_000_000))).toBe(
      ErrorCode.ORDER_REMITTANCE_NOT_PENDING,
    );

    const { orderId: onTheWay } = await shippingOrder();
    expect(await codeOf(confirm(onTheWay, 7_000_000))).toBe(
      ErrorCode.ORDER_REMITTANCE_NOT_PENDING,
    );
  });

  it('keeps a staff account to its own branch', async () => {
    const orderId = await deliveredOrder(DeliveryCollectionMethod.CASH);
    const staff = {
      userId: randomUUID(),
      tenantId,
      systemRole: SystemRole.STAFF,
      permissions: new Set<string>(['orders:confirm_cash']),
      branchId: otherBranchId,
      warehouseId: null,
    } as unknown as AuthUser;
    expect(
      await codeOf(
        remittances.confirm(staff, tenantId, orderId, { amount: 7_000_000 }),
      ),
    ).toBe(ErrorCode.ORDER_BRANCH_DENIED);
  });

  it('does not find another tenant’s order', async () => {
    expect(
      await codeOf(
        remittances.confirm(owner, randomUUID(), randomUUID(), {
          amount: 1,
        }),
      ),
    ).toBe(ErrorCode.ORDER_NOT_FOUND);
  });
});
