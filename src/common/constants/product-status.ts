/** Product lifecycle. DISCONTINUED is the soft delete, since order items, stock movements and inventory all point at variants. */
export const ProductStatus = {
  ACTIVE: 'ACTIVE',
  INACTIVE: 'INACTIVE',
  DISCONTINUED: 'DISCONTINUED',
} as const;

export type ProductStatus = (typeof ProductStatus)[keyof typeof ProductStatus];

/** What a client may set directly - DISCONTINUED is reachable only via DELETE. */
export const SETTABLE_PRODUCT_STATUSES: readonly string[] = [
  ProductStatus.ACTIVE,
  ProductStatus.INACTIVE,
];

/** What a list endpoint may be filtered by. */
export const FILTERABLE_PRODUCT_STATUSES: readonly string[] = [
  ProductStatus.ACTIVE,
  ProductStatus.INACTIVE,
  ProductStatus.DISCONTINUED,
];

/** Statuses that still count against the plan's `maxProducts` quota - a discontinued product frees its slot. */
export const QUOTA_COUNTED_PRODUCT_STATUSES: readonly string[] = [
  ProductStatus.ACTIVE,
  ProductStatus.INACTIVE,
];
