import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PromotionService } from '../promotions/promotions.service';
import { ErrorCode } from '../../common/errors/error-codes';
import type { Prisma } from '../../../generated/prisma/client';

/** Một dòng client gửi; `unitPrice` chỉ có ở đơn tay. */
export interface PricingLineInput {
  productItemId: string;
  quantity: number;
  unitPrice?: number;
  discountAmount?: number;
}

export interface PricingInput {
  branchId: string;
  customerId?: string;
  /** Khách sẽ được tạo cùng đơn: chưa dùng lượt khuyến mãi nào (xem `CartContext.newCustomer`). */
  newCustomer?: boolean;
  /** Đơn đang được tính lại (sửa đơn): lượt khuyến mãi của chính nó không tính là đã dùng. */
  orderId?: string;
  items: PricingLineInput[];
  appliedPromotions?: { promotionId: string }[];
  discountType?: string;
  discountValue?: number;
}

export type PricedLine = Awaited<
  ReturnType<OrderPricingService['priceLines']>
>[number];

/** Tính tiền đơn, dùng chung cho quầy và đơn tay. */
@Injectable()
export class OrderPricingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly promotions: PromotionService,
  ) {}

  /** Tính toàn bộ tiền đơn ở server, khuyến mãi qua engine của `/promotions/calculate`. */
  async priceOrder(tenantId: string, input: PricingInput) {
    const lines = await this.priceLines(tenantId, input.items);
    const promotionIds = [
      ...new Set((input.appliedPromotions ?? []).map((p) => p.promotionId)),
    ];

    if (promotionIds.length === 0) {
      if (input.discountType === 'ORDER' && !input.discountValue) {
        throw new BadRequestException({
          code: ErrorCode.ORDER_DISCOUNT_VALUE_REQUIRED,
          message:
            'An order-level discount needs a discountValue greater than 0',
        });
      }
      return {
        lines,
        appliedPromotions: [],
        discountType: input.discountType ?? null,
        discountValue: input.discountValue ?? 0,
      };
    }

    // Một đơn chỉ một loại giảm giá.
    if (input.discountType === 'ORDER') {
      throw new BadRequestException({
        code: ErrorCode.ORDER_DISCOUNT_CONFLICT,
        message:
          'An order cannot carry both an order-level discount and a promotion',
      });
    }
    // Đơn tay không dùng được cả giá thoả thuận lẫn khuyến mãi.
    if (lines.some((line) => line.unitPrice !== line.listUnitPrice)) {
      throw new BadRequestException({
        code: ErrorCode.ORDER_DISCOUNT_CONFLICT,
        message:
          'An order cannot carry both a negotiated unit price and a promotion',
      });
    }

    const pricing = await this.promotions.calculate(tenantId, {
      branchId: input.branchId,
      customerId: input.customerId,
      newCustomer: input.newCustomer,
      orderId: input.orderId,
      items: lines.map((line) => ({
        productItemId: line.productItemId,
        quantity: line.quantity,
      })),
      promotionIds,
    });

    // Ghép kết quả engine theo vị trí dòng.
    if (pricing.itemBreakdown.length !== lines.length) {
      throw new BadRequestException({
        code: ErrorCode.ORDER_PROMOTION_ALLOCATION_MISMATCH,
        message: 'The discount could not be matched to the order lines',
      });
    }

    return {
      // Phân bổ khuyến mãi ghi đè giảm tay trên dòng.
      lines: lines.map((line, index) => ({
        ...line,
        discountAmount: pricing.itemBreakdown[index].discountAmount,
      })),
      appliedPromotions: pricing.appliedPromotions,
      discountType: 'PROMOTION',
      discountValue: pricing.totalDiscount,
    };
  }

  /** Tính các dòng của đơn; giảm tay không được vượt thành tiền dòng. */
  async priceLines(tenantId: string, items: PricingLineInput[]) {
    const ids = [...new Set(items.map((item) => item.productItemId))];
    const variants = await this.prisma.productItem.findMany({
      where: { tenantId, id: { in: ids } },
      select: {
        id: true,
        sku: true,
        productName: true,
        retailPrice: true,
        vat: true,
        itemType: true,
      },
    });
    if (variants.length !== ids.length) {
      throw new NotFoundException({
        code: ErrorCode.PRODUCT_ITEM_NOT_FOUND,
        message: 'Product item not found in this order',
      });
    }
    const byId = new Map(variants.map((v) => [v.id, v]));

    return items.map((item) => {
      const variant = byId.get(item.productItemId)!;
      const listUnitPrice = Number(variant.retailPrice);
      const unitPrice = item.unitPrice ?? listUnitPrice;
      const discountAmount = item.discountAmount ?? 0;
      // Làm tròn giống `grandTotalOf`, để trần và phép trừ khớp đến từng đồng.
      const lineTotal = Math.round(item.quantity * unitPrice);
      if (discountAmount > lineTotal) {
        throw new BadRequestException({
          code: ErrorCode.ORDER_LINE_DISCOUNT_EXCEEDS_TOTAL,
          message: `A discount of ${discountAmount} exceeds the line total for ${variant.sku ?? variant.productName} (${lineTotal})`,
        });
      }
      return {
        productItemId: item.productItemId,
        productName: variant.productName,
        sku: variant.sku,
        itemType: variant.itemType,
        vatRate: variant.vat,
        quantity: item.quantity,
        listUnitPrice,
        unitPrice,
        discountAmount,
      };
    });
  }

  /** Ghi lượt dùng khuyến mãi của đơn vừa tạo, trong transaction tạo đơn (`PromotionService.recordUsage`). */
  recordPromotionUsage(
    tx: Prisma.TransactionClient,
    tenantId: string,
    input: Parameters<PromotionService['recordUsage']>[2],
  ) {
    // Đơn không có khuyến mãi không đụng tới bảng khuyến mãi.
    if (input.applied.length === 0) return Promise.resolve();
    return this.promotions.recordUsage(tx, tenantId, input);
  }

  /** Đưa lượt dùng về đúng khuyến mãi đơn đang mang, trong transaction sửa đơn. */
  syncPromotionUsage(
    tx: Prisma.TransactionClient,
    tenantId: string,
    input: Parameters<PromotionService['syncOrderUsage']>[2],
  ) {
    return this.promotions.syncOrderUsage(tx, tenantId, input);
  }

  /** Thành tiền một dòng như lưu trong `order_items.line_total`: làm tròn trước khi trừ giảm, không âm. */
  lineTotalOf(line: {
    quantity: number;
    unitPrice: number;
    discountAmount: number;
  }): number {
    return Math.max(
      0,
      Math.round(line.quantity * line.unitPrice) - line.discountAmount,
    );
  }

  /** Tổng thành tiền các dòng sau giảm từng dòng. */
  subtotalOf(
    lines: { quantity: number; unitPrice: number; discountAmount: number }[],
  ): number {
    return lines.reduce((sum, line) => sum + this.lineTotalOf(line), 0);
  }

  /** Số khách phải trả cho hàng, không âm, chưa cộng phí giao. */
  grandTotalOf(
    lines: { quantity: number; unitPrice: number; discountAmount: number }[],
    discountType: string | null,
    discountValue: number,
  ): number {
    // Làm tròn từng dòng trước khi trừ giảm, giống `pricing-engine.ts`.
    const afterLineDiscounts = lines.reduce(
      (sum, line) => sum + this.lineTotalOf(line),
      0,
    );
    // Chặn đơn có tổng bằng 0 do giảm giá.
    const orderDiscount =
      discountType === 'ORDER'
        ? Math.min(Math.max(0, discountValue), afterLineDiscounts)
        : 0;
    return Math.max(0, Math.round(afterLineDiscounts - orderDiscount));
  }
}
