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

/** `ProductItem.itemType`. Only a PRODUCT holds stock of its own: a COMBO is priced as a set and stocked through its components, and a SERVICE needs no goods at all. */
export const ProductItemType = {
  PRODUCT: 'PRODUCT',
  COMBO: 'COMBO',
  SERVICE: 'SERVICE',
} as const;

export type ProductItemType =
  (typeof ProductItemType)[keyof typeof ProductItemType];

/**
 * `Product.productType` (2026-10-23): which screen a product lives on - `/products` lists PRODUCT
 * and SERVICE, `/combos` lists COMBO. Fixed at create, like `itemType`: turning a product that has
 * held stock into a combo would strand that stock.
 */
export const ProductType = {
  PRODUCT: 'PRODUCT',
  COMBO: 'COMBO',
  SERVICE: 'SERVICE',
} as const;

export type ProductType = (typeof ProductType)[keyof typeof ProductType];

export const PRODUCT_TYPES: readonly string[] = Object.values(ProductType);

/**
 * The SKU type every variant of a product of this type must have - the one copy of the rule.
 * It is one-to-one on purpose: a COMBO variant inside a PRODUCT product would sit on the
 * products screen while being a combo, which is what the product-level type exists to stop.
 * `itemType` stays on `product_items` because orders, stock and combo expansion read it per line.
 */
export function itemTypeFor(productType: ProductType): ProductItemType {
  return productType;
}

/** Whether a variant of this type may have stock rows and lots. The one copy of "only a PRODUCT holds stock". */
export function holdsStock(itemType: string): boolean {
  return itemType === ProductItemType.PRODUCT;
}
