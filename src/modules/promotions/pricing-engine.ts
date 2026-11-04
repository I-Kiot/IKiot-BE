import { BadRequestException } from '@nestjs/common';
import {
  ApplicableRuleType,
  DiscountType,
  MAX_STACKED_PROMOTIONS,
  PromotionStatus,
} from './promotion.constants';
import { ErrorCode } from '../../common/errors/error-codes';

/** Bộ tính giảm giá, không truy cập DB: caller tải khuyến mãi ứng viên, resolve category từng dòng, nạp sẵn số lần dùng của khách. Nhờ vậy mọi rule thu ngân phải bảo vệ đều test được không cần kết nối. Khuyến mãi luôn được chọn tường minh; module không tự chọn tổ hợp “tốt nhất”, vì máy tính tiền áp mức khác với mức đã bấm sẽ thành ticket hỗ trợ. */

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
  /** Số thứ tự dòng trong giỏ. Một giỏ có thể có cùng `productItemId` ở nhiều dòng, nên variant id không định danh được dòng; phân bổ theo variant rồi đọc lại theo dòng sẽ nhân đôi mức giảm và đưa đơn về 0đ. */
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

/** Mức giảm tự thân của một khuyến mãi, trước khi kẹp khi cộng dồn. FIXED_AMOUNT không bao giờ vượt giá trị các mặt hàng khớp, nếu không voucher 100k trên món 40k sẽ trả tiền cho khách. */
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

/** Khuyến mãi này có dùng được cho giỏ không, và nếu không thì vì sao? Lý do hiển thị cho thu ngân nên mọi nhánh đều phải trả về lý do; `customerUsageCounts` chỉ cần entry cho khuyến mãi giới hạn theo khách. */
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

/** Mọi khuyến mãi ứng viên kèm điều kiện và mức giảm xem trước độc lập, cả cái không đủ điều kiện (kèm lý do), vì câu hỏi "sao không dùng được voucher này" chính là câu người dùng đang hỏi. */
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

/** Chia mức giảm của mỗi khuyến mãi cho các dòng nó khớp theo tỷ trọng đóng góp, rồi kẹp tổng giảm của từng dòng về thành tiền dòng. Không kẹp thì hai khuyến mãi cộng dồn trên cùng SKU sẽ khiến đơn nợ khách tiền. */
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

/** Resolve đúng tập khuyến mãi khách đã chọn với giỏ; ném 400 khi có cái không tồn tại, không đủ điều kiện hoặc vi phạm quy tắc cộng dồn. Bỏ lặng lẽ một cái sẽ thu của khách nhiều hơn màn hình đã hiện. */
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
  // Một phần tử cho mỗi dòng giỏ, theo đúng thứ tự giỏ. Caller ghép lại theo vị trí, đây là cách ghép duy nhất còn đúng khi cùng variant xuất hiện hai lần.
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
