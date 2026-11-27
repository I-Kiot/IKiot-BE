import 'dotenv/config';
import { randomUUID } from 'crypto';
import { Test } from '@nestjs/testing';
import { PrismaModule } from './../src/prisma/prisma.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { InvoiceService } from './../src/modules/invoices/invoices.service';
import { OrderService } from './../src/modules/orders/orders.service';
import { OrderPricingService } from './../src/modules/orders/order-pricing.service';
import { ManualOrderService } from './../src/modules/orders/manual-order.service';
import { OrderCustomizationService } from './../src/modules/orders/order-customization.service';
import { OrderShortageAlerts } from './../src/modules/orders/order-shortage-alerts';
import { ProductionListService } from './../src/modules/production-requests/production-list.service';
import { OrderEditService } from './../src/modules/orders/order-edit.service';
import { OrderReadService } from './../src/modules/orders/order-read.service';
import { SepayOrderService } from './../src/modules/orders/sepay-order.service';
import { CustomerService } from './../src/modules/customers/customers.service';
import { InventoryService } from './../src/modules/inventories/inventories.service';
import { FulfillmentService } from './../src/modules/fulfillments/fulfillments.service';
import { NotificationService } from './../src/modules/notifications/notifications.service';
import { PromotionService } from './../src/modules/promotions/promotions.service';
import { RealtimeGateway } from './../src/common/realtime/realtime.gateway';
import { SystemRole } from './../src/common/constants/system-role';
import { UserStatus } from './../src/common/constants/user-status';
import { WALK_IN_CUSTOMER_CODE } from './../src/common/constants/walk-in-customer';
import { ErrorCode } from './../src/common/errors/error-codes';
import type { AuthUser } from './../src/common/types/auth-user.type';
import type { CreateOrderDto } from './../src/modules/orders/dto/create-order.dto';

/**
 * Lượt dùng khuyến mãi ghi cùng transaction tạo / sửa đơn (Postgres thật): khách cũ hết lượt bị từ chối, khách mới
 * tạo cùng đơn bắt đầu từ 0 lượt, khách vãng lai không dùng được khuyến mãi giới hạn theo khách, sửa đơn không tính
 * lượt của chính nó và bỏ khuyến mãi thì trả lượt.
 */
describe('Promotion usage committed with the order', () => {
  let prisma: PrismaService;
  let manual: ManualOrderService;
  let edits: OrderEditService;
  let promotions: PromotionService;

  const tenantId = randomUUID();
  const ownerId = randomUUID();
  const branchId = randomUUID();
  const productId = randomUUID();
  const sofaId = randomUUID(); // 10.000.000
  const customerId = randomUUID();
  let promotionId = '';
  const newPhone = `08${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;

  const owner = {
    userId: ownerId,
    tenantId,
    systemRole: SystemRole.TENANT_OWNER,
    permissions: new Set<string>(),
    branchId: null,
    warehouseId: null,
  } as unknown as AuthUser;

  const createOrder = async (over: Partial<CreateOrderDto> = {}) =>
    (
      await manual.create(owner, tenantId, {
        branchId,
        assigneeId: ownerId,
        fulfillmentType: 'STORE_PICKUP',
        items: [{ productItemId: sofaId, quantity: 1 }],
        appliedPromotions: [{ promotionId }],
        ...over,
      })
    ).id;

  const codeOf = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      return (error as { getResponse(): { code: string } }).getResponse().code;
    }
    return undefined;
  };

  const usedCount = async () =>
    (
      await prisma.promotion.findUniqueOrThrow({
        where: { id: promotionId },
        select: { usedCount: true },
      })
    ).usedCount;
  const logsOf = (orderId: string) =>
    prisma.promotionLog.findMany({
      where: { orderId },
      select: { customerId: true, discountAmount: true },
    });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [
        InvoiceService,
        OrderService,
        OrderPricingService,
        ManualOrderService,
        OrderCustomizationService,
        OrderShortageAlerts,
        ProductionListService,
        OrderEditService,
        OrderReadService,
        CustomerService,
        InventoryService,
        FulfillmentService,
        PromotionService,
        {
          provide: NotificationService,
          useValue: {
            managersOfLocation: () => Promise.resolve([]),
            notify: jest.fn(),
          },
        },
        { provide: RealtimeGateway, useValue: {} },
        { provide: SepayOrderService, useValue: {} },
      ],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    manual = moduleRef.get(ManualOrderService);
    edits = moduleRef.get(OrderEditService);
    promotions = moduleRef.get(PromotionService);

    await prisma.tenant.create({ data: { id: tenantId, name: 'promo-e2e' } });
    await prisma.user.create({
      data: {
        id: ownerId,
        tenantId,
        phoneNumber: `promo-${ownerId}`,
        systemRole: SystemRole.TENANT_OWNER,
        status: UserStatus.ACTIVE,
      },
    });
    await prisma.location.create({
      data: { id: branchId, tenantId, name: 'CN', type: 'BRANCH' },
    });
    await prisma.branch.create({
      data: { id: branchId, tenantId, locationId: branchId },
    });
    await prisma.product.create({
      data: { id: productId, tenantId, name: 'Nội thất' },
    });
    await prisma.productItem.create({
      data: {
        id: sofaId,
        tenantId,
        productId,
        productName: 'Sofa',
        productCode: `PROMO-${sofaId}`,
        sku: `PROMO-${sofaId.slice(0, 8)}`,
        retailPrice: 10_000_000,
        costPrice: 0,
        itemType: 'PRODUCT',
      },
    });
    await prisma.customer.create({
      data: { id: customerId, tenantId, name: 'Khách cũ', phone: '0900000001' },
    });
    // Giảm 10% (tối đa 500.000), mỗi khách 1 lượt, tổng 2 lượt.
    const promotion = await promotions.create(tenantId, {
      promoName: 'Mỗi khách một lần',
      discountType: 'PERCENT',
      discountValue: 10,
      maxDiscountAmount: 500_000,
      applicableRule: { type: 'all' },
      startDate: new Date(Date.now() - 86_400_000).toISOString(),
      endDate: new Date(Date.now() + 86_400_000).toISOString(),
      usageLimit: 2,
      usageLimitPerCustomer: 1,
    } as Parameters<PromotionService['create']>[1]);
    promotionId = promotion.id;
  });

  afterAll(async () => {
    await prisma.promotionLog.deleteMany({ where: { tenantId } });
    await prisma.cashFlow.deleteMany({ where: { tenantId } });
    await prisma.payment.deleteMany({ where: { tenantId } });
    await prisma.invoice.deleteMany({ where: { tenantId } });
    await prisma.orderItem.deleteMany({ where: { order: { tenantId } } });
    await prisma.order.deleteMany({ where: { tenantId } });
    await prisma.promotion.deleteMany({ where: { tenantId } });
    await prisma.customer.deleteMany({ where: { tenantId } });
    await prisma.productItem.deleteMany({ where: { tenantId } });
    await prisma.product.deleteMany({ where: { tenantId } });
    await prisma.branch.deleteMany({ where: { tenantId } });
    await prisma.location.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
    await prisma.$disconnect();
  });

  let firstOrder = '';

  it('counts the use inside the order transaction, for the order customer', async () => {
    firstOrder = await createOrder({ customerId });
    expect(await usedCount()).toBe(1);
    const logs = await logsOf(firstOrder);
    expect(logs).toHaveLength(1);
    expect(logs[0].customerId).toBe(customerId);
    expect(Number(logs[0].discountAmount)).toBe(500_000);
  });

  it('refuses the same customer a second time and leaves the count untouched', async () => {
    expect(await codeOf(createOrder({ customerId }))).toBe(
      ErrorCode.PROMOTION_NOT_ELIGIBLE,
    );
    expect(await usedCount()).toBe(1);
  });

  it('refuses a walk-in sale - no customer, or the walk-in row named explicitly', async () => {
    expect(await codeOf(createOrder())).toBe(ErrorCode.PROMOTION_NOT_ELIGIBLE);
    const walkIn = await prisma.customer.create({
      data: {
        tenantId,
        customerCode: WALK_IN_CUSTOMER_CODE,
        name: 'Khách vãng lai',
      },
    });
    expect(await codeOf(createOrder({ customerId: walkIn.id }))).toBe(
      ErrorCode.PROMOTION_NOT_ELIGIBLE,
    );
    const preview = await promotions.listCandidates(tenantId, {
      branchId,
      items: [{ productItemId: sofaId, quantity: 1 }],
    });
    const entry = [
      ...preview.branchPromotions,
      ...preview.systemPromotions,
    ].find((p) => p.id === promotionId);
    expect(entry?.eligible).toBe(false);
    expect(entry?.reason).toMatch(/Khách vãng lai/);
    expect(await usedCount()).toBe(1);
  });

  it('lets a customer created with the order start from zero uses', async () => {
    // Xem trước: khách mới chưa có id, `newCustomer` cho biết chưa dùng lượt nào.
    const preview = await promotions.calculate(tenantId, {
      branchId,
      newCustomer: true,
      items: [{ productItemId: sofaId, quantity: 1 }],
      promotionIds: [promotionId],
    });
    expect(preview.totalDiscount).toBe(500_000);

    const orderId = await createOrder({
      customer: { name: 'Khách mới', phone: newPhone },
    });
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { customerId: true, grandTotal: true },
    });
    expect(Number(order.grandTotal)).toBe(9_500_000);
    const logs = await logsOf(orderId);
    expect(logs).toHaveLength(1);
    // Lượt tính cho chính khách vừa tạo, nên lần sau họ là khách cũ đã dùng 1 lượt.
    expect(logs[0].customerId).toBe(order.customerId);
    expect(await usedCount()).toBe(2);
  });

  it('re-prices an edited order without counting its own use, then gives the use back when the promotion is removed', async () => {
    // Đã dùng hết 2 lượt chung, khách dùng hết 1 lượt riêng - lượt của chính đơn này không tính.
    await edits.update(owner, tenantId, firstOrder, {
      items: [{ productItemId: sofaId, quantity: 2 }],
    });
    expect(await usedCount()).toBe(2);
    expect(await logsOf(firstOrder)).toHaveLength(1);

    await edits.update(owner, tenantId, firstOrder, { appliedPromotions: [] });
    expect(await usedCount()).toBe(1);
    expect(await logsOf(firstOrder)).toEqual([]);
  });

  it('keeps the old /promotions/apply call from counting an order twice', async () => {
    const orderId = await createOrder({
      customerId: undefined,
      customer: { name: 'Khách 3', phone: `07${newPhone.slice(2)}` },
    });
    expect(await usedCount()).toBe(2);
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { customerId: true },
    });
    await promotions.apply(tenantId, ownerId, {
      branchId,
      customerId: order.customerId,
      orderId,
      items: [{ productItemId: sofaId, quantity: 1 }],
      promotionIds: [promotionId],
    });
    expect(await usedCount()).toBe(2);
    expect(await logsOf(orderId)).toHaveLength(1);
  });
});
