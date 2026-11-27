import { BadRequestException } from '@nestjs/common';
import {
  ApplicableRuleType,
  DiscountType,
  MAX_STACKED_PROMOTIONS,
  PromotionStatus,
} from './promotion.constants';
import { ErrorCode } from '../../common/errors/error-codes';

/** Bộ tính khuyến mãi không truy cập DB; khuyến mãi luôn được chọn tường minh. */

/** Khuyến mãi theo hình dạng module này cần. Service map từ dòng Prisma sang. */
export interface PricingPromotion {
  id: string;
  promoName: string;
  /** Chỉ để hiển thị cho người chọn; không rule nào dưới đây đọc trường này. */
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
  /** Rỗng = áp dụng toàn chuỗi; có giá trị = chỉ tại các chi nhánh này. */
  branchIds: string[];
  applicableRuleType: string;
  ruleCategoryIds: string[];
  ruleProductItemIds: string[];
}

export interface CartItem {
  /** Số thứ tự dòng trong giỏ. */
  lineId: number;
  productItemId: string;
  categoryId: string | null;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

export interface CartContext {
  branchId: string | null;
  /** Khách thật của giỏ; null là khách vãng lai hoặc chưa có khách. */
  customerId: string | null;
  /**
   * Giỏ của một khách sẽ được tạo cùng đơn (chưa có id): chưa dùng lượt nào, nên khuyến mãi giới hạn theo khách vẫn
   * áp được. Chỉ có nghĩa khi `customerId` null.
   */
  newCustomer?: boolean;
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

/** Tiền lưu 2 chữ số thập phân nhưng giảm giá là đồng nguyên - chỉ làm tròn một lần, ở biên. */
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

/** Mức giảm của một khuyến mãi, không vượt giá trị hàng khớp. */
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

/** Khuyến mãi có dùng được cho giỏ không và lý do. */
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
    // Giới hạn theo khách vô nghĩa nếu không biết khách là ai, nên giỏ vãng lai bị loại thay vì cho qua.
    // Khách mới (tạo cùng đơn) thì đã biết là ai và chưa dùng lượt nào.
    if (!cart.customerId && !cart.newCustomer) {
      return {
        eligible: false,
        reason:
          'Khách vãng lai không dùng được khuyến mãi giới hạn lượt theo khách - chọn hoặc tạo khách hàng',
      };
    }
    const used = cart.customerId ? (customerUsageCounts[promotion.id] ?? 0) : 0;
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

/** Mọi khuyến mãi ứng viên kèm điều kiện và mức giảm xem trước. */
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

/** Chia mức giảm cho các dòng, kẹp về thành tiền dòng. */
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

/** Áp các khuyến mãi đã chọn; ném 400 khi có cái không hợp lệ. */
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
  // Một phần tử cho mỗi dòng giỏ, theo thứ tự.
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
