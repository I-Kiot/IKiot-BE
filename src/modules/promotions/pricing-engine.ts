import { BadRequestException } from '@nestjs/common';
import {
  ApplicableRuleType,
  DiscountType,
  MAX_STACKED_PROMOTIONS,
  PromotionStatus,
} from './promotion.constants';
import { ErrorCode } from '../../common/errors/error-codes';

/** The discount calculator, with no database access by design: the caller fetches the candidate promotions, resolves each line's category and pre-loads this customer's usage counts, then hands it all in - so every rule a cashier has to defend is testable without a connection. Applying a promotion is always explicit; this module never guesses a "best" combination, since a till that picks a different discount than the one tapped is a support call. */

/** A promotion, in the shape this module needs. The service maps Prisma rows into it. */
export interface PricingPromotion {
  id: string;
  promoName: string;
  /** Carried for the picker's benefit only - no rule below reads it. */
  description: string | null;
  status: string;
  startDate: Date;
  endDate: Date;
  discountType: string;
  discountValue: number;
  maxDiscountAmount: number | null;
  minOrderValue: number;
  stackable: boolean;
  usageLimit: number | null;
  usageLimitPerCustomer: number | null;
  usedCount: number;
  /** Empty = applies tenant-wide. Non-empty = only at these branches. */
  branchIds: string[];
  applicableRuleType: string;
  ruleCategoryIds: string[];
  ruleProductItemIds: string[];
}

export interface CartItem {
  /** Which line of the cart this is. A cart may hold the same `productItemId` on more than one line, so the variant id does not identify a line - allocating per variant id and reading back per line multiplied the discount and took orders to 0đ. */
  lineId: number;
  productItemId: string;
  categoryId: string | null;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

export interface CartContext {
  branchId: string | null;
  customerId: string | null;
  subtotal: number;
  items: CartItem[];
}

export interface EligibilityVerdict {
  eligible: boolean;
  reason: string | null;
}

export interface CandidateEntry {
  promotion: PricingPromotion;
  eligible: boolean;
  reason: string | null;
  matchedItems: CartItem[];
  previewDiscount: number;
}

export interface PricingResult {
  appliedPromotions: {
    promotionId: string;
    promoName: string;
    discountAmount: number;
  }[];
  totalDiscount: number;
  itemBreakdown: { productItemId: string; discountAmount: number }[];
  grandTotal: number;
}

/** Money is stored to 2dp but discounts are whole đồng - round once, at the edges. */
const round = (amount: number): number => Math.round(amount);

const vnd = (amount: number) => amount.toLocaleString('vi-VN');

export function ruleMatchesItem(
  promotion: PricingPromotion,
  item: CartItem,
): boolean {
  switch (promotion.applicableRuleType) {
    case ApplicableRuleType.ALL:
      return true;
    case ApplicableRuleType.CATEGORY:
      return (
        item.categoryId !== null &&
        promotion.ruleCategoryIds.includes(item.categoryId)
      );
    case ApplicableRuleType.PRODUCT:
      return promotion.ruleProductItemIds.includes(item.productItemId);
    default:
      return false;
  }
}

export function getMatchedItems(
  promotion: PricingPromotion,
  items: CartItem[],
): CartItem[] {
  return items.filter((item) => ruleMatchesItem(promotion, item));
}

export function isWithinDateRange(
  promotion: PricingPromotion,
  now: Date,
): boolean {
  return now >= promotion.startDate && now <= promotion.endDate;
}

export function matchedSubtotal(matchedItems: CartItem[]): number {
  return matchedItems.reduce((sum, item) => sum + item.lineTotal, 0);
}

/** What one promotion is worth on its own, before any stacking clamp; a FIXED_AMOUNT discount never exceeds what the matched items are worth, or a 100k voucher on a 40k item would pay the customer. */
export function rawDiscount(
  promotion: PricingPromotion,
  matchedItems: CartItem[],
): number {
  const subtotal = matchedSubtotal(matchedItems);

  if (promotion.discountType === DiscountType.PERCENT) {
    const amount = (subtotal * promotion.discountValue) / 100;
    return round(
      promotion.maxDiscountAmount !== null
        ? Math.min(amount, promotion.maxDiscountAmount)
        : amount,
    );
  }

  return round(Math.min(promotion.discountValue, subtotal));
}

/** Can this promotion be used on this cart, and if not, why not? The reason is shown to the cashier, so every branch returns one; `customerUsageCounts` needs an entry only for promotions that cap per customer. */
export function evaluateEligibility(
  promotion: PricingPromotion,
  cart: CartContext,
  now: Date = new Date(),
  customerUsageCounts: Record<string, number> = {},
): EligibilityVerdict {
  if (promotion.status !== PromotionStatus.ACTIVE) {
    return { eligible: false, reason: 'Khuyến mãi không hoạt động' };
  }
  if (!isWithinDateRange(promotion, now)) {
    return {
      eligible: false,
      reason: 'Khuyến mãi chưa bắt đầu hoặc đã kết thúc',
    };
  }
  if (
    promotion.branchIds.length > 0 &&
    (cart.branchId === null || !promotion.branchIds.includes(cart.branchId))
  ) {
    return { eligible: false, reason: 'Không áp dụng cho chi nhánh này' };
  }
  if (cart.subtotal < promotion.minOrderValue) {
    return {
      eligible: false,
      reason: `Đơn hàng chưa đạt giá trị tối thiểu ${vnd(promotion.minOrderValue)}đ`,
    };
  }
  if (
    promotion.usageLimit !== null &&
    promotion.usedCount >= promotion.usageLimit
  ) {
    return { eligible: false, reason: 'Khuyến mãi đã hết lượt sử dụng' };
  }
  if (promotion.usageLimitPerCustomer !== null) {
    // A per-customer cap means nothing without knowing who the customer is, so an anonymous cart is excluded rather than waved through.
    if (!cart.customerId) {
      return {
        eligible: false,
        reason: 'Cần chọn khách hàng để áp dụng khuyến mãi này',
      };
    }
    const used = customerUsageCounts[promotion.id] ?? 0;
    if (used >= promotion.usageLimitPerCustomer) {
      return {
        eligible: false,
        reason: 'Khách hàng đã hết lượt sử dụng khuyến mãi này',
      };
    }
  }
  if (getMatchedItems(promotion, cart.items).length === 0) {
    return {
      eligible: false,
      reason: 'Không áp dụng cho sản phẩm trong giỏ hàng',
    };
  }
  return { eligible: true, reason: null };
}

/** Every candidate promotion with its eligibility and a standalone preview of what it would take off - ineligible ones included, with the reason, because "why can't I use this voucher" is the question being asked. */
export function buildCandidateList(
  promotions: PricingPromotion[],
  cart: CartContext,
  now: Date = new Date(),
  customerUsageCounts: Record<string, number> = {},
): CandidateEntry[] {
  return promotions.map((promotion) => {
    const { eligible, reason } = evaluateEligibility(
      promotion,
      cart,
      now,
      customerUsageCounts,
    );
    const matchedItems = getMatchedItems(promotion, cart.items);
    return {
      promotion,
      eligible,
      reason,
      matchedItems,
      previewDiscount: eligible ? rawDiscount(promotion, matchedItems) : 0,
    };
  });
}

/** Spreads each promotion's discount across the lines it matched in proportion to what each contributes, then clamps each line's accumulated discount to its own total - without the clamp, two stackable promotions on one SKU would leave the order owing the customer money. */
export function allocatePerItemDiscount(
  applied: { matchedItems: CartItem[]; discount: number }[],
): Map<number, number> {
  const perLine = new Map<number, number>();

  for (const { matchedItems, discount } of applied) {
    const subtotal = matchedSubtotal(matchedItems);
    if (subtotal <= 0 || discount <= 0) continue;
    for (const item of matchedItems) {
      const share = round((item.lineTotal / subtotal) * discount);
      perLine.set(item.lineId, (perLine.get(item.lineId) ?? 0) + share);
    }
  }

  for (const item of applied.flatMap((entry) => entry.matchedItems)) {
    const current = perLine.get(item.lineId) ?? 0;
    if (current > item.lineTotal) {
      perLine.set(item.lineId, item.lineTotal);
    }
  }

  return perLine;
}

function emptyResult(cart: CartContext): PricingResult {
  return {
    appliedPromotions: [],
    totalDiscount: 0,
    itemBreakdown: cart.items.map((item) => ({
      productItemId: item.productItemId,
      discountAmount: 0,
    })),
    grandTotal: round(cart.subtotal),
  };
}

/** Resolves the exact set of promotions the user chose against the cart, throwing a 400 when one is unknown, ineligible or breaks the stacking rules: quietly dropping one would charge the customer more than the screen said. */
export function resolveSelectedPromotions(
  promotions: PricingPromotion[],
  selectedIds: string[],
  cart: CartContext,
  now: Date = new Date(),
  customerUsageCounts: Record<string, number> = {},
): PricingResult {
  const uniqueIds = [...new Set(selectedIds)];
  if (uniqueIds.length === 0) return emptyResult(cart);

  if (uniqueIds.length > MAX_STACKED_PROMOTIONS) {
    throw new BadRequestException({
      code: ErrorCode.PROMOTION_STACK_LIMIT,
      message: `At most ${MAX_STACKED_PROMOTIONS} promotions can be combined`,
    });
  }

  const byId = new Map(
    promotions.map((promotion) => [promotion.id, promotion]),
  );
  const resolved = uniqueIds.map((id) => {
    const promotion = byId.get(id);
    if (!promotion) {
      throw new BadRequestException({
        code: ErrorCode.PROMOTION_NOT_APPLICABLE,
        message:
          'One of the selected promotions no longer exists or does not apply to this order',
      });
    }
    const { eligible, reason } = evaluateEligibility(
      promotion,
      cart,
      now,
      customerUsageCounts,
    );
    if (!eligible) {
      throw new BadRequestException({
        code: ErrorCode.PROMOTION_NOT_ELIGIBLE,
        message: `Promotion "${promotion.promoName}" is not eligible: ${reason}`,
      });
    }
    return promotion;
  });

  if (resolved.length > 1 && !resolved.every((p) => p.stackable)) {
    throw new BadRequestException({
      code: ErrorCode.PROMOTION_NOT_STACKABLE,
      message: 'Only stackable promotions can be added on top',
    });
  }

  const computed = resolved.map((promotion) => {
    const matchedItems = getMatchedItems(promotion, cart.items);
    return {
      promotion,
      matchedItems,
      discount: rawDiscount(promotion, matchedItems),
    };
  });

  const perLine = allocatePerItemDiscount(computed);
  // One entry per cart line, in cart order - the caller joins it back positionally, the only join that survives the same variant appearing twice.
  const itemBreakdown = cart.items.map((item) => ({
    productItemId: item.productItemId,
    discountAmount: perLine.get(item.lineId) ?? 0,
  }));

  const totalDiscount = Math.min(
    itemBreakdown.reduce((sum, item) => sum + item.discountAmount, 0),
    cart.subtotal,
  );

  return {
    appliedPromotions: computed.map(({ promotion, discount }) => ({
      promotionId: promotion.id,
      promoName: promotion.promoName,
      discountAmount: discount,
    })),
    totalDiscount: round(totalDiscount),
    itemBreakdown,
    grandTotal: round(cart.subtotal - totalDiscount),
  };
}
