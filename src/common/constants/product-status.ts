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

/** Loại SKU: chỉ PRODUCT giữ kho, COMBO giữ qua thành phần, SERVICE không cần hàng. */
export const ProductItemType = {
  PRODUCT: 'PRODUCT',
  COMBO: 'COMBO',
  SERVICE: 'SERVICE',
} as const;

export type ProductItemType =
  (typeof ProductItemType)[keyof typeof ProductItemType];

/** Loại sản phẩm, cố định khi tạo. */
export const ProductType = {
  PRODUCT: 'PRODUCT',
  COMBO: 'COMBO',
  SERVICE: 'SERVICE',
} as const;

export type ProductType = (typeof ProductType)[keyof typeof ProductType];

export const PRODUCT_TYPES: readonly string[] = Object.values(ProductType);

/** Loại SKU bắt buộc theo loại sản phẩm. */
export function itemTypeFor(productType: ProductType): ProductItemType {
  return productType;
}

/** Loại SKU có được giữ tồn kho và lô không. */
export function holdsStock(itemType: string): boolean {
  return itemType === ProductItemType.PRODUCT;
}
