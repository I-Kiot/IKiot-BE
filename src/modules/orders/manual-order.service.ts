import { InvoiceService } from '../invoices/invoices.service';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CustomerService } from '../customers/customers.service';
import { OrderService } from './orders.service';
import { OrderPricingService, type PricedLine } from './order-pricing.service';
import { OrderCustomizationService } from './order-customization.service';
import { OrderShortageAlerts } from './order-shortage-alerts';
import { assertNoPickupShippingFee } from './order-pickup.rules';
import { assertDeliveryInfoComplete } from './order-delivery.rules';
import { writePaymentCashFlow } from './order-cash-flow';
import { CashFlowCategory } from '../../common/constants/cash-flow-category';
import { syncOrderPaymentStatus } from './payment-status';
import { CreateOrderDto, DepositType } from './dto/create-order.dto';
import type { ComboLeaf } from './combo-expansion';
import { buildOrderItemRows, expandCombos } from './order-combo';
import {
  FulfillmentType,
  OrderChannel,
  OrderLineType,
  OrderPriority,
  OrderStatus,
} from '../../common/constants/order-status';
import {
  PaymentKind,
  PaymentRecordStatus,
} from '../../common/constants/payment-method';
import { LocationStatus } from '../../common/constants/location-status';
import { SystemRole } from '../../common/constants/system-role';
import { UserStatus } from '../../common/constants/user-status';
import {
  generateReference,
  REFERENCE_PREFIX,
} from '../../common/utils/reference-generator';
import { ErrorCode } from '../../common/errors/error-codes';
import type { AuthUser } from '../../common/types/auth-user.type';
import type { Prisma } from '../../../generated/prisma/client';
import { OrderEventType } from '../../common/constants/order-event-type';
import {
  type OrderEventInput,
  recordOrderEvents,
  userActor,
} from './order-events';

const ASSIGNABLE_ROLES: readonly string[] = [
  SystemRole.TENANT_OWNER,
  SystemRole.STAFF,
];

/** Chủ shop xem được đơn ở mọi nơi nên phụ trách được ở mọi nơi; nhân viên chỉ ở nơi mình làm. */
function worksAt(
  person: { systemRole: string; locationId: string | null },
  placeId: string,
): boolean {
  return (
    person.systemRole === SystemRole.TENANT_OWNER ||
    person.locationId === placeId
  );
}

export interface ResolvedDeposit {
  amount: number;
  percent: number | null;
  method: string;
}

/** Loại dòng bán; COMBO_COMPONENT chỉ server thêm. */
const SELLABLE_LINE_TYPES: readonly string[] = [
  OrderLineType.PRODUCT,
  OrderLineType.COMBO,
  OrderLineType.SERVICE,
];

/** Tính cọc của đơn tay: theo % hoặc số tiền, không được vượt giá trị đơn. */
export function resolveDeposit(
  deposit: { type: string; value: number; method: string } | undefined,
  grandTotal: number,
): ResolvedDeposit | null {
  if (!deposit) return null;
  let amount: number;
  let percent: number | null = null;
  if (deposit.type === DepositType.PERCENT) {
    if (deposit.value > 100) {
      throw new BadRequestException({
        code: ErrorCode.ORDER_DEPOSIT_EXCEEDS_TOTAL,
        message: `A deposit of ${deposit.value}% exceeds the order total`,
      });
    }
    percent = deposit.value;
    amount = Math.round((grandTotal * deposit.value) / 100);
  } else {
    amount = Math.round(deposit.value);
  }
  if (amount > grandTotal) {
    throw new BadRequestException({
      code: ErrorCode.ORDER_DEPOSIT_EXCEEDS_TOTAL,
      message: `A deposit of ${amount} exceeds the order total of ${grandTotal}`,
    });
  }
  if (amount === 0) return null;
  return { amount, percent, method: deposit.method };
}

/** Tạo đơn tay (`POST /orders`) ở CONFIRMED, không giữ kho. */
@Injectable()
export class ManualOrderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrderService,
    private readonly pricing: OrderPricingService,
    private readonly customers: CustomerService,
    private readonly customizations: OrderCustomizationService,
    private readonly shortages: OrderShortageAlerts,
    private readonly invoices: InvoiceService,
  ) {}

  async create(user: AuthUser, tenantId: string, dto: CreateOrderDto) {
    const userId = user.userId;
    const scope = this.orders.branchScope(user);
    if (scope.branchId !== undefined && dto.branchId !== scope.branchId) {
      throw new ForbiddenException({
        code: ErrorCode.ORDER_BRANCH_DENIED,
        message: 'You can only create orders for your own branch',
      });
    }
    if (!dto.assigneeId) {
      throw new BadRequestException({
        code: ErrorCode.ORDER_ASSIGNEE_REQUIRED,
        message: 'A manual order needs a person in charge',
      });
    }

    const branch = await this.prisma.branch.findFirst({
      where: { id: dto.branchId, tenantId },
      select: {
        id: true,
        location: {
          select: { defaultFulfillmentLocationId: true },
        },
      },
    });
    if (!branch)
      throw new NotFoundException({
        code: ErrorCode.BRANCH_NOT_FOUND,
        message: 'Branch not found',
      });

    await this.assertAssignee(tenantId, dto.assigneeId, dto.branchId);
    if (dto.customerId)
      await this.orders.assertCustomerExists(tenantId, dto.customerId);

    // Id của Branch cũng là id của Location nên chính chi nhánh là phương án cuối.
    const defaultSource =
      branch.location.defaultFulfillmentLocationId ?? branch.id;
    await this.assertSourceLocations(tenantId, dto.items);

    const priced = await this.pricing.priceOrder(tenantId, dto);
    const { appliedPromotions, discountType, discountValue } = priced;
    const lines = priced.lines.map((line, index) => ({
      ...line,
      sourceLocationId: dto.items[index].sourceLocationId ?? defaultSource,
    }));
    this.assertSellableLines(lines);
    lines.forEach((line, index) => {
      if (dto.items[index].customization)
        this.customizations.assertCustomizable(line.itemType);
    });
    const components = await this.expandCombos(tenantId, lines);

    const subtotal = this.pricing.subtotalOf(lines);
    const goodsTotal = this.pricing.grandTotalOf(
      lines,
      discountType,
      discountValue,
    );
    const shippingFee = Math.round(dto.shippingFee ?? 0);
    const isPickup = dto.fulfillmentType === FulfillmentType.STORE_PICKUP;
    // Khách tới lấy thì không có phí giao hàng và không có địa chỉ giao.
    if (isPickup) assertNoPickupShippingFee(shippingFee);
    assertDeliveryInfoComplete(dto.fulfillmentType, dto);
    const grandTotal = goodsTotal + shippingFee;
    const deposit = resolveDeposit(dto.deposit, grandTotal);

    // Tạo khách trước transaction.
    const typedInCustomerId =
      !dto.customerId && dto.customer
        ? await this.customers.findOrCreateForOrder(tenantId, dto.customer)
        : undefined;

    const items = this.buildItems(lines, components);
    // buildItems trả dòng theo đúng thứ tự gửi, con của combo nằm ngay sau combo cha.
    const topLevelRows = items.filter((row) => !row.parentItemId);
    const now = new Date();

    const shortage = await this.shortages.snapshot(tenantId, items);

    const orderId = await this.prisma.$transaction(async (tx) => {
      const customerId =
        dto.customerId ??
        typedInCustomerId ??
        (await this.orders.resolveWalkInCustomer(tx, tenantId));

      const created = await tx.order.create({
        data: {
          tenantId,
          branchId: branch.id,
          customerId,
          code: generateReference(REFERENCE_PREFIX.ORDER),
          status: OrderStatus.CONFIRMED,
          priority: dto.priority ?? OrderPriority.NORMAL,
          channel: OrderChannel.MANUAL,
          fulfillmentType: dto.fulfillmentType,
          userId,
          assigneeId: dto.assigneeId,
          // Tạo đơn tay cũng là xác nhận đơn (contract §2), không có bước nháp.
          confirmedById: userId,
          confirmedAt: now,
          subtotal,
          shippingFee,
          grandTotal,
          discountType,
          discountValue,
          depositAmount: deposit?.amount ?? null,
          depositPercent: deposit?.percent ?? null,
          // Trạng thái thanh toán suy ra từ các khoản sau khi ghi cọc.
          recipientName: dto.recipientName,
          recipientPhone: dto.recipientPhone,
          deliveryAddress: isPickup ? undefined : dto.deliveryAddress,
          requestedDeliveryDate: dto.requestedDeliveryDate
            ? new Date(dto.requestedDeliveryDate)
            : undefined,
          note: dto.note,
          // Một câu INSERT cho mọi dòng để con của combo tham chiếu được cha được chèn cùng lúc.
          items: { createMany: { data: items } },
          appliedPromotions: { create: appliedPromotions },
        },
        select: { id: true, code: true },
      });

      const events: OrderEventInput[] = [
        {
          tenantId,
          orderId: created.id,
          type: OrderEventType.CREATED,
          fromStatus: null,
          toStatus: OrderStatus.CONFIRMED,
          metadata: { grandTotal, fulfillmentType: dto.fulfillmentType },
        },
      ];
      if (deposit) {
        // Tiền cọc đã nhận nên Payment là PAID và vào sổ thu chi ngay.
        const payment = await tx.payment.create({
          data: {
            tenantId,
            orderId: created.id,
            kind: PaymentKind.DEPOSIT,
            method: deposit.method,
            amount: deposit.amount,
            status: PaymentRecordStatus.PAID,
            paidAt: now,
            locationId: branch.id,
            collectedById: userId,
            createdById: userId,
          },
          select: { id: true, amount: true, method: true },
        });
        await writePaymentCashFlow(tx, {
          tenantId,
          payment,
          category: CashFlowCategory.ORDER_PAYMENT,
          orderId: created.id,
          orderCode: created.code,
          locationId: branch.id,
          createdById: userId,
          description: `Tiền cọc đơn ${created.code}`,
        });
        await syncOrderPaymentStatus(tx, created.id);
        events.push({
          tenantId,
          orderId: created.id,
          type: OrderEventType.DEPOSIT_RECORDED,
          metadata: {
            paymentId: payment.id,
            amount: deposit.amount,
            method: deposit.method,
          },
        });
      }
      for (const [index, item] of dto.items.entries()) {
        if (!item.customization) continue;
        const row = topLevelRows[index];
        await this.customizations.apply(
          tx,
          tenantId,
          {
            id: row.id!,
            productItemId: row.productItemId,
            lineType: row.lineType!,
            isCustom: false,
          },
          item.customization,
          user.userId,
        );
      }
      // Hóa đơn chỉ phát hành khi đơn COMPLETED (đã giao và thu đủ); trước đó là hóa đơn PENDING.
      await this.invoices.ensurePending(tx, created.id);
      await recordOrderEvents(tx, userActor(user), events);
      return created.id;
    });

    await this.shortages.notify(tenantId, orderId, shortage, userId);
    return this.orders.findOne(user, tenantId, orderId);
  }

  /** Chỉ sản phẩm, combo hoặc dịch vụ mới là dòng riêng; thành phần combo do server thêm. */
  assertSellableLines(lines: readonly PricedLine[]) {
    for (const line of lines) {
      if (!SELLABLE_LINE_TYPES.includes(line.itemType)) {
        throw new BadRequestException({
          code: ErrorCode.ORDER_COMBO_INVALID,
          message: `${line.sku ?? line.productName} cannot be sold as an order line`,
        });
      }
    }
  }

  /** Kiểm người phụ trách làm việc tại địa điểm bán của đơn. */
  async assertAssignee(tenantId: string, assigneeId: string, placeId: string) {
    const assignee = await this.prisma.user.findFirst({
      where: {
        id: assigneeId,
        tenantId,
        status: UserStatus.ACTIVE,
        systemRole: { in: [...ASSIGNABLE_ROLES] },
      },
      select: { systemRole: true, locationId: true },
    });
    if (!assignee) {
      throw new BadRequestException({
        code: ErrorCode.ORDER_ASSIGNEE_INVALID,
        message: 'The person in charge is not an active account of this shop',
      });
    }
    if (!worksAt(assignee, placeId)) {
      throw new BadRequestException({
        code: ErrorCode.ORDER_ASSIGNEE_WRONG_LOCATION,
        message: 'The person in charge must work at the location of the order',
      });
    }
  }

  /** Danh sách người nhận được đơn tại nơi bán này. */
  async listAssignableAt(tenantId: string, placeId: string) {
    const people = await this.prisma.user.findMany({
      where: {
        tenantId,
        status: UserStatus.ACTIVE,
        systemRole: { in: [...ASSIGNABLE_ROLES] },
        OR: [{ systemRole: SystemRole.TENANT_OWNER }, { locationId: placeId }],
      },
      select: {
        id: true,
        phoneNumber: true,
        profileFirstName: true,
        profileLastName: true,
        systemRole: true,
        locationId: true,
      },
      orderBy: [{ profileFirstName: 'asc' }, { phoneNumber: 'asc' }],
    });
    // Lọc lại bằng chính `worksAt`, để danh sách và lần kiểm khi ghi là một luật.
    return people.filter((person) => worksAt(person, placeId));
  }

  /** Địa điểm bán và lấy hàng được (chi nhánh, kho còn hoạt động). */
  listSourceLocations(tenantId: string) {
    return this.prisma.location.findMany({
      where: { tenantId, status: LocationStatus.ACTIVE },
      select: {
        id: true,
        type: true,
        name: true,
        defaultFulfillmentLocationId: true,
      },
      orderBy: [{ type: 'asc' }, { name: 'asc' }],
    });
  }

  /** Kiểm mọi kho xuất trên dòng còn hoạt động và thuộc tenant. */
  async assertSourceLocations(
    tenantId: string,
    items: readonly { sourceLocationId?: string }[],
  ) {
    const ids = [
      ...new Set(
        items
          .map((item) => item.sourceLocationId)
          .filter((id): id is string => id !== undefined),
      ),
    ];
    if (ids.length === 0) return;
    const found = await this.prisma.location.findMany({
      where: { tenantId, id: { in: ids } },
      select: { id: true, status: true },
    });
    const byId = new Map(found.map((location) => [location.id, location]));
    for (const id of ids) {
      const location = byId.get(id);
      if (!location || location.status !== LocationStatus.ACTIVE) {
        throw new BadRequestException({
          code: ErrorCode.ORDER_SOURCE_LOCATION_INVALID,
          message: `Location ${id} cannot ship this order`,
        });
      }
    }
  }

  expandCombos(tenantId: string, lines: readonly PricedLine[]) {
    return expandCombos(this.prisma, tenantId, lines);
  }

  buildItems(
    lines: readonly (PricedLine & { sourceLocationId: string })[],
    components: Map<string, ComboLeaf[]>,
  ): Prisma.OrderItemCreateManyOrderInput[] {
    return buildOrderItemRows(lines, components, (line) =>
      this.pricing.lineTotalOf(line),
    );
  }
}
