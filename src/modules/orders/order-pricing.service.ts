import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PromotionService } from '../promotions/promotions.service';
import { ErrorCode } from '../../common/errors/error-codes';

/** One line as a client sends it. `unitPrice` is only ever set by the order journey's manual create (a negotiated price); the till never sends one and is always priced from the catalogue. */
export interface PricingLineInput {
  productItemId: string;
  quantity: number;
  unitPrice?: number;
  discountAmount?: number;
}

/** What both creates hand to `priceOrder` - the till's `CreatePosOrderDto` and the journey's `CreateOrderDto` each satisfy it structurally. */
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

/** The money side of a sale, shared by the till (`OrderService.createPosSale`) and the order journey's manual create (`ManualOrderService`) so both price a basket by the same rules. */
@Injectable()
export class OrderPricingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly promotions: PromotionService,
  ) {}

  /** Everything about the sale's money, worked out here rather than taken on trust. The promotion discount is priced server-side through the same engine `/promotions/calculate` runs - it used to be assumed the client had echoed a breakdown back, so a till that sent only a total got a full-price order and no error - and the engine re-checks eligibility, so an expired or out-of-branch promotion is a 400 instead of a discount. The variants are looked up twice on a promotion sale; one extra indexed read is the price of the engine owning its own view of the cart. */
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

    // One discountType per order, so the two kinds can't be stacked - the schema has nowhere to record a total that is part manual and part promotion.
    if (input.discountType === 'ORDER') {
      throw new BadRequestException({
        code: ErrorCode.ORDER_DISCOUNT_CONFLICT,
        message:
          'An order cannot carry both an order-level discount and a promotion',
      });
    }
    // The engine prices every line at `retailPrice` (it never takes a price from the caller), so a negotiated price under a promotion would be discounted off a number the line doesn't carry. A manual order takes one or the other.
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

    // Joined by position, never by `productItemId`: the engine returns one entry per cart line in cart order, and keying by variant id collapsed duplicate lines, handing each the sum of their shares - ten identical lines under a 10% promotion came out at 100% off.
    if (pricing.itemBreakdown.length !== lines.length) {
      throw new BadRequestException({
        code: ErrorCode.ORDER_PROMOTION_ALLOCATION_MISMATCH,
        message: 'The discount could not be matched to the order lines',
      });
    }

    return {
      // The engine's allocation replaces whatever the client sent, including a manual line discount: two discounts on one line have no home in the schema.
      lines: lines.map((line, index) => ({
        ...line,
        discountAmount: pricing.itemBreakdown[index].discountAmount,
      })),
      appliedPromotions: pricing.appliedPromotions,
      discountType: 'PROMOTION',
      discountValue: pricing.totalDiscount,
    };
  }

  /** The lines of a sale. `listUnitPrice` is always `ProductItem.retailPrice`; `unitPrice` is the same unless the caller negotiated one - the till never can, which used to let `unitPrice: 0` ring up a full basket for nothing. The manual per-line discount is capped at the line's own total and going over is a 400, not a silent trim - clamping would leave the stored `discount_amount` larger than the discount given, and `/stats/top-products` would report that product's revenue as negative. */
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
      // Rounded the same way `grandTotalOf` rounds the line, so the cap and the subtraction agree to the đồng.
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

  /** One line's total as stored in `order_items.line_total`: rounded before its discount comes off, never below zero. */
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

  /** What the customer actually owes for the goods: line totals minus per-line discounts, then a manual whole-order discount. A PROMOTION discount is not subtracted again - `priceOrder` has already spread it across the lines. Never below zero. Shipping is the caller's to add. */
  grandTotalOf(
    lines: { quantity: number; unitPrice: number; discountAmount: number }[],
    discountType: string | null,
    discountValue: number,
  ): number {
    // Each line is rounded before its discount comes off, exactly as `pricing-engine.ts` does; rounding once at the end would leave a promotion sale a đồng or two from the total the preview quoted.
    const afterLineDiscounts = lines.reduce(
      (sum, line) => sum + this.lineTotalOf(line),
      0,
    );
    // Capped at what the order is actually worth: `Math.max(0, …)` alone only stopped the total going negative, so a cashier could still settle any basket at 0đ.
    const orderDiscount =
      discountType === 'ORDER'
        ? Math.min(Math.max(0, discountValue), afterLineDiscounts)
        : 0;
    return Math.max(0, Math.round(afterLineDiscounts - orderDiscount));
  }
}
