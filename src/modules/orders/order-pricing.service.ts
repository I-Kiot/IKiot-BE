import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PromotionService } from '../promotions/promotions.service';
import { ErrorCode } from '../../common/errors/error-codes';

/** Một dòng như client gửi. `unitPrice` chỉ đến từ lúc tạo đơn tay (giá mặc cả); quầy không bao giờ gửi, luôn tính theo danh mục. */
export interface PricingLineInput {
  productItemId: string;
  quantity: number;
  unitPrice?: number;
  discountAmount?: number;
}

export interface PricingInput {
  branchId: string;
  customerId?: string;
  items: PricingLineInput[];
  appliedPromotions?: { promotionId: string }[];
  discountType?: string;
  discountValue?: number;
}

export type PricedLine = Awaited<
  ReturnType<OrderPricingService['priceLines']>
>[number];

/** Phần tiền của một đơn, dùng chung cho quầy (`OrderService.createPosSale`) và tạo đơn tay (`ManualOrderService`) để cả hai tính giỏ hàng theo cùng quy tắc. */
@Injectable()
export class OrderPricingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly promotions: PromotionService,
  ) {}

  /**
   * Tính toàn bộ tiền của đơn ở server, không tin số client gửi. Khuyến mãi đi qua engine của `/promotions/calculate`, nên KM hết hạn hoặc sai chi nhánh bị trả 400 chứ không lặng lẽ giảm giá.
   * Đơn có khuyến mãi tra biến thể hai lần; lần đọc thêm là cái giá để engine tự giữ bản nhìn của giỏ.
   */
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

    // Một discountType cho mỗi đơn nên hai loại không cộng dồn được: schema không có chỗ ghi tổng vừa tay vừa khuyến mãi.
    if (input.discountType === 'ORDER') {
      throw new BadRequestException({
        code: ErrorCode.ORDER_DISCOUNT_CONFLICT,
        message:
          'An order cannot carry both an order-level discount and a promotion',
      });
    }
    // Engine luôn tính mỗi dòng theo `retailPrice` (không nhận giá từ bên gọi), nên giá thỏa thuận cộng khuyến mãi sẽ bị giảm trên một số mà dòng không mang. Đơn tay chỉ được một trong hai.
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
      items: lines.map((line) => ({
        productItemId: line.productItemId,
        quantity: line.quantity,
      })),
      promotionIds,
    });

    // Ghép theo vị trí, không theo `productItemId`: engine trả một mục cho mỗi dòng giỏ. Ghép theo id biến thể sẽ gộp các dòng trùng và nhân đôi mức giảm (10 dòng giống nhau dưới KM 10% từng ra giảm 100%).
    if (pricing.itemBreakdown.length !== lines.length) {
      throw new BadRequestException({
        code: ErrorCode.ORDER_PROMOTION_ALLOCATION_MISMATCH,
        message: 'The discount could not be matched to the order lines',
      });
    }

    return {
      // Phân bổ của engine ghi đè mọi thứ client gửi, kể cả giảm tay trên dòng: hai khoản giảm trên một dòng không có chỗ trong schema.
      lines: lines.map((line, index) => ({
        ...line,
        discountAmount: pricing.itemBreakdown[index].discountAmount,
      })),
      appliedPromotions: pricing.appliedPromotions,
      discountType: 'PROMOTION',
      discountValue: pricing.totalDiscount,
    };
  }

  /**
   * Các dòng của một đơn. `listUnitPrice` luôn là `ProductItem.retailPrice`; `unitPrice` bằng nó trừ khi bên gọi thoả thuận giá khác (quầy thì không được). Giảm tay mỗi dòng bị chặn bởi thành tiền của chính dòng; vượt thì trả 400 chứ không cắt âm thầm, vì `discount_amount` lưu lớn hơn số đã giảm sẽ làm `/stats/top-products` báo doanh thu âm.
   */
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

  /** Tổng thành tiền các dòng (sau giảm từng dòng, trước giảm tay cả đơn và phí giao): cột `orders.subtotal`. Một nơi cho đơn tay, đơn quầy và sửa đơn: trước đây đơn quầy không đặt cột này nên hoá đơn của nó có subtotal 0. */
  subtotalOf(
    lines: { quantity: number; unitPrice: number; discountAmount: number }[],
  ): number {
    return lines.reduce((sum, line) => sum + this.lineTotalOf(line), 0);
  }

  /** Số khách thực phải trả cho hàng: thành tiền các dòng trừ giảm từng dòng, rồi trừ giảm tay cả đơn. Khuyến mãi không trừ lại vì `priceOrder` đã phân bổ vào các dòng. Không âm. Phí giao do bên gọi cộng thêm. */
  grandTotalOf(
    lines: { quantity: number; unitPrice: number; discountAmount: number }[],
    discountType: string | null,
    discountValue: number,
  ): number {
    // Làm tròn từng dòng trước khi trừ giảm, giống `pricing-engine.ts`. Làm tròn một lần ở cuối sẽ lệch vài đồng so với tổng preview đã báo.
    const afterLineDiscounts = lines.reduce(
      (sum, line) => sum + this.lineTotalOf(line),
      0,
    );
    // Chặn theo giá trị thật của đơn: chỉ `Math.max(0, …)` thì tổng không âm nhưng thu ngân vẫn chốt được cả giỏ với giá 0đ.
    const orderDiscount =
      discountType === 'ORDER'
        ? Math.min(Math.max(0, discountValue), afterLineDiscounts)
        : 0;
    return Math.max(0, Math.round(afterLineDiscounts - orderDiscount));
  }
}
