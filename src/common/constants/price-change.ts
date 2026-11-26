/** Trường giá bị đổi. */
export const PriceChangeField = {
  RETAIL_PRICE: 'RETAIL_PRICE',
  COST_PRICE: 'COST_PRICE',
} as const;

export type PriceChangeField =
  (typeof PriceChangeField)[keyof typeof PriceChangeField];
