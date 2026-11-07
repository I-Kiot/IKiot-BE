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
import { writePaymentCashFlow } from './order-cash-flow';
import { FlowType } from '../stats/stats.constants';
import { CreateOrderDto, DepositType } from './dto/create-order.dto';
import type { ComboLeaf } from './combo-expansion';
import { buildOrderItemRows, expandCombos } from './order-combo';
import {
  FulfillmentType,
  OrderChannel,
  OrderLineType,
  OrderPaymentStatus,
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

const ASSIGNABLE_ROLES: readonly string[] = [
  SystemRole.TENANT_OWNER,
  SystemRole.STAFF,
];

export interface ResolvedDeposit {
  amount: number;
  percent: number | null;
  method: string;
}

/** `itemType` của ProductItem dùng chung từ vựng với loại dòng bán. `COMBO_COMPONENT` không bao giờ do client gửi, chỉ server thêm dưới dòng COMBO. */
const SELLABLE_LINE_TYPES: readonly string[] = [
  OrderLineType.PRODUCT,
  OrderLineType.COMBO,
  OrderLineType.SERVICE,
];

/**
 * Cọc của đơn tay: PERCENT tính trên tổng và làm tròn tới đồng, AMOUNT lấy đúng số nhập; 0 là không cọc. Cọc lớn hơn giá trị đơn bị từ chối chứ không cắt xuống, vì khách đã đưa đúng số đó. `orders_deposit_valid` ràng buộc cùng giới hạn trong SQL.
 */
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

/** `paymentStatus` của đơn khi tiền duy nhất là cọc (trước khi giao thu phần còn lại). */
export function paymentStatusForDeposit(
  depositAmount: number,
  grandTotal: number,
): string {
  if (depositAmount <= 0) return OrderPaymentStatus.UNPAID;
  return depositAmount >= grandTotal
    ? OrderPaymentStatus.PAID
    : OrderPaymentStatus.PARTIALLY_PAID;
}

/** `POST /orders` (A-2): đơn tay nhân viên nhập cho khách đặt qua online hay điện thoại. Sinh ra ở CONFIRMED có người phụ trách, không giữ kho và không bị từ chối vì thiếu hàng; thiếu hàng chỉ chặn ở bước đóng gói (C-1). Bán tại quầy là `OrderService.createPosSale`. */
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
          select: { defaultFulfillmentLocationId: true, isSellable: true },
        },
      },
    });
    if (!branch)
      throw new NotFoundException({
        code: ErrorCode.BRANCH_NOT_FOUND,
        message: 'Branch not found',
      });
    // Chi nhánh và kho đều bán được, trừ kho hàng hỏng.
    if (!branch.location.isSellable) {
      throw new BadRequestException({
        code: ErrorCode.LOCATION_NOT_SELLABLE,
        message: 'This location holds stock that is not for sale',
      });
    }

    await this.assertAssignee(tenantId, dto.assigneeId);
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

    const subtotal = lines.reduce(
      (sum, line) => sum + this.pricing.lineTotalOf(line),
      0,
    );
    const goodsTotal = this.pricing.grandTotalOf(
      lines,
      discountType,
      discountValue,
    );
    const shippingFee = Math.round(dto.shippingFee ?? 0);
    const isPickup = dto.fulfillmentType === FulfillmentType.STORE_PICKUP;
    // Khách tới lấy thì không có phí giao hàng và không có địa chỉ giao.
    if (isPickup) assertNoPickupShippingFee(shippingFee);
    const grandTotal = goodsTotal + shippingFee;
    const deposit = resolveDeposit(dto.deposit, grandTotal);
    const paymentStatus = paymentStatusForDeposit(
      deposit?.amount ?? 0,
      grandTotal,
    );

    // Tạo khách trước transaction vì CustomerService giữ dãy mã và quy tắc một số điện thoại một khách. Mọi bước có thể từ chối đơn đã chạy xong, nên khách thừa chỉ còn lại khi DB lỗi, và vẫn là khách thật.
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
          paymentStatus,
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
          select: { id: true },
        });
        await writePaymentCashFlow(tx, {
          tenantId,
          paymentId: payment.id,
          orderId: created.id,
          orderCode: created.code,
          flowType: FlowType.INCOME,
          amount: deposit.amount,
          method: deposit.method,
          locationId: branch.id,
          createdById: userId,
          description: `Tiền cọc đơn ${created.code}`,
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
        );
      }
      // Hóa đơn chỉ phát hành khi đơn COMPLETED (đã giao và thu đủ); trước đó là hóa đơn PENDING.
      await this.invoices.ensurePending(tx, created.id);
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

  /** Người phụ trách phải đăng nhập được vào shop và làm đơn. Dùng chung với route sửa đơn (A-8). */
  async assertAssignee(tenantId: string, assigneeId: string) {
    const assignee = await this.prisma.user.findFirst({
      where: {
        id: assigneeId,
        tenantId,
        status: UserStatus.ACTIVE,
        systemRole: { in: [...ASSIGNABLE_ROLES] },
      },
      select: { id: true },
    });
    if (!assignee) {
      throw new BadRequestException({
        code: ErrorCode.ORDER_ASSIGNEE_INVALID,
        message: 'The person in charge is not an active account of this shop',
      });
    }
  }

  /**
   * Nơi đơn bán và lấy hàng được: chi nhánh và kho còn hoạt động, trừ kho hàng hỏng. Route riêng vì nhân viên bán hàng chỉ có `read_own` trên chi nhánh / kho,
   * nên danh sách địa điểm thường trả rỗng với họ. Chỉ trả tên và loại. Cùng quy tắc với `assertSourceLocations`.
   */
  listSourceLocations(tenantId: string) {
    return this.prisma.location.findMany({
      where: { tenantId, status: LocationStatus.ACTIVE, isSellable: true },
      select: {
        id: true,
        type: true,
        name: true,
        defaultFulfillmentLocationId: true,
      },
      orderBy: [{ type: 'asc' }, { name: 'asc' }],
    });
  }

  /** Mọi kho xuất trên dòng phải là kho còn hoạt động của tenant và có hàng bán được; kho hàng hỏng không bao giờ giao cho khách. */
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
      select: { id: true, status: true, isSellable: true },
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
      if (!location.isSellable) {
        throw new BadRequestException({
          code: ErrorCode.LOCATION_NOT_SELLABLE,
          message: `Location ${id} holds stock that is not for sale`,
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
