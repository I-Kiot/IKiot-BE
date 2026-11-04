/** Vòng đời sản phẩm. DISCONTINUED là xoá mềm, vì dòng đơn, phiếu kho và tồn kho vẫn trỏ tới biến thể. */
export const ProductStatus = {
  ACTIVE: 'ACTIVE',
  INACTIVE: 'INACTIVE',
  DISCONTINUED: 'DISCONTINUED',
} as const;

export type ProductStatus = (typeof ProductStatus)[keyof typeof ProductStatus];

/** Trạng thái client được đặt trực tiếp - DISCONTINUED chỉ đạt được qua DELETE. */
export const SETTABLE_PRODUCT_STATUSES: readonly string[] = [
  ProductStatus.ACTIVE,
  ProductStatus.INACTIVE,
];

export const FILTERABLE_PRODUCT_STATUSES: readonly string[] = [
  ProductStatus.ACTIVE,
  ProductStatus.INACTIVE,
  ProductStatus.DISCONTINUED,
];

/** Trạng thái còn tính vào hạn mức `maxProducts` của gói - sản phẩm ngừng bán thì trả lại suất. */
export const QUOTA_COUNTED_PRODUCT_STATUSES: readonly string[] = [
  ProductStatus.ACTIVE,
  ProductStatus.INACTIVE,
];

/** `ProductItem.itemType`. Chỉ PRODUCT tự giữ kho: COMBO được tính giá như một bộ và giữ kho qua thành phần; SERVICE không cần hàng. */
export const ProductItemType = {
  PRODUCT: 'PRODUCT',
  COMBO: 'COMBO',
  SERVICE: 'SERVICE',
} as const;

export type ProductItemType =
  (typeof ProductItemType)[keyof typeof ProductItemType];

/**
 * `Product.productType`: `/products` liệt kê PRODUCT và SERVICE, `/combos` liệt kê COMBO. Cố định khi tạo, như `itemType`: đổi sản phẩm đã có tồn thành combo sẽ làm mất số tồn đó.
 */
export const ProductType = {
  PRODUCT: 'PRODUCT',
  COMBO: 'COMBO',
  SERVICE: 'SERVICE',
} as const;

export type ProductType = (typeof ProductType)[keyof typeof ProductType];

export const PRODUCT_TYPES: readonly string[] = Object.values(ProductType);

/**
 * Loại SKU mà mọi biến thể của sản phẩm loại này phải có. Quan hệ 1-1 có chủ ý, để chặn biến thể COMBO nằm trong sản phẩm PRODUCT. `itemType` vẫn nằm trên `product_items` vì đơn, kho và mở rộng combo đọc theo từng dòng.
 */
export function itemTypeFor(productType: ProductType): ProductItemType {
  return productType;
}

/** Biến thể loại này có được có dòng tồn kho và lot hay không. Bản duy nhất của quy tắc "chỉ PRODUCT giữ kho". */
export function holdsStock(itemType: string): boolean {
  return itemType === ProductItemType.PRODUCT;
}
