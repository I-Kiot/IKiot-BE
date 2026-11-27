export const DiscountType = {
  PERCENT: 'PERCENT',
  FIXED_AMOUNT: 'FIXED_AMOUNT',
} as const;

export type DiscountType = (typeof DiscountType)[keyof typeof DiscountType];

export const DISCOUNT_TYPES: readonly string[] = Object.values(DiscountType);

/** Phạm vi áp dụng; viết thường vì đây đúng là chuỗi FE gửi và iKiotMS-BE đã lưu. */
export const ApplicableRuleType = {
  ALL: 'all',
  CATEGORY: 'category',
  PRODUCT: 'product',
} as const;

export type ApplicableRuleType =
  (typeof ApplicableRuleType)[keyof typeof ApplicableRuleType];

export const APPLICABLE_RULE_TYPES: readonly string[] =
  Object.values(ApplicableRuleType);

export const PromotionStatus = {
  ACTIVE: 'ACTIVE',
  INACTIVE: 'INACTIVE',
} as const;

export type PromotionStatus =
  (typeof PromotionStatus)[keyof typeof PromotionStatus];

export const PROMOTION_STATUSES: readonly string[] =
  Object.values(PromotionStatus);

/** Tối đa hai khuyến mãi cộng dồn. */
export const MAX_STACKED_PROMOTIONS = 2;
