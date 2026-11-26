/** Loại dòng sổ kho: số lượng có dấu, mỗi dòng tác động đúng một lô. */
export const InventoryTxType = {
  IMPORT: 'IMPORT',
  TRANSFER_OUT: 'TRANSFER_OUT',
  TRANSFER_IN: 'TRANSFER_IN',
  /** Đã xuất nhưng chưa nhận - phần chênh giữa số xuất và số nhận của phiếu chuyển kho. */
  TRANSFER_LOSS: 'TRANSFER_LOSS',
  ADJUST: 'ADJUST',
  SALE: 'SALE',
  /** Đơn đã đóng gói bị huỷ trước khi bàn giao: hàng trở về đúng các lot đã xuất ra. */
  SALE_REVERSAL: 'SALE_REVERSAL',
  RETURN_GOOD: 'RETURN_GOOD',
  /** Khách trả hàng hỏng: về lô con hỏng tại nơi nhận, không vào `stock`. */
  RETURN_DAMAGED: 'RETURN_DAMAGED',
  /** Hàng lỗi từ phiếu nhập xưởng: mở lô hỏng tại nơi nhận, không vào `stock`. */
  DEFECT: 'DEFECT',
  /** Phát hiện hỏng trên kệ: rút lô bán được, thêm lô hỏng cùng địa điểm. */
  MARK_DAMAGED: 'MARK_DAMAGED',
  /** Hàng hỏng đã sửa xong: dòng âm rút lô hỏng, dòng dương vào lô con bán được cùng địa điểm. */
  REPAIRED: 'REPAIRED',
  /** Huỷ / thanh lý hàng hỏng: dòng âm rút lô hỏng, hàng rời khỏi sổ. */
  WRITE_OFF: 'WRITE_OFF',
  /** Tồn kho có từ trước khi có lot, được migration mở một lần. */
  OPENING: 'OPENING',
} as const;

export type InventoryTxType =
  (typeof InventoryTxType)[keyof typeof InventoryTxType];

/** `InventoryTransaction.referenceType` - chứng từ nào sinh ra dòng này. */
export const InventoryRefType = {
  STOCK_MOVEMENT: 'STOCK_MOVEMENT',
  FULFILLMENT: 'FULFILLMENT',
  ORDER: 'ORDER',
  PRODUCTION_REQUEST: 'PRODUCTION_REQUEST',
  ORDER_RETURN: 'ORDER_RETURN',
  /** Chuyển tồn có sẵn thành lô; cũng là chứng từ của đánh dấu hỏng, sửa xong, huỷ hàng hỏng. */
  INVENTORY: 'INVENTORY',
} as const;

export type InventoryRefType =
  (typeof InventoryRefType)[keyof typeof InventoryRefType];

/** Nguồn gốc lô hàng, giữ nguyên khi lô bị tách do chuyển kho hay trả hàng. */
export const LotSourceType = {
  SUPPLIER: 'SUPPLIER',
  WORKSHOP: 'WORKSHOP',
  /** Hàng dư khi kiểm kê. */
  ADJUSTMENT: 'ADJUSTMENT',
  /** Tồn kho có trước khi có lot. */
  OPENING: 'OPENING',
} as const;

export type LotSourceType = (typeof LotSourceType)[keyof typeof LotSourceType];

/** Hai luồng nhập hàng (NCC / xưởng), chỉ đặt cho phiếu IMPORT. */
export const ImportSource = {
  SUPPLIER: 'SUPPLIER',
  WORKSHOP: 'WORKSHOP',
} as const;

export type ImportSource = (typeof ImportSource)[keyof typeof ImportSource];

export const IMPORT_SOURCES: readonly string[] = Object.values(ImportSource);

/** Loại nhà cung cấp: GOODS bán thành phẩm, WORKSHOP làm theo yêu cầu sản xuất. */
export const SupplierType = {
  GOODS: 'GOODS',
  WORKSHOP: 'WORKSHOP',
} as const;

export type SupplierType = (typeof SupplierType)[keyof typeof SupplierType];

export const SUPPLIER_TYPES: readonly string[] = Object.values(SupplierType);

/** Luồng nhập mà mỗi loại nhà cung cấp được phép đưa vào. */
export const IMPORT_SOURCE_FOR_SUPPLIER_TYPE: Readonly<
  Record<SupplierType, ImportSource>
> = {
  [SupplierType.GOODS]: ImportSource.SUPPLIER,
  [SupplierType.WORKSHOP]: ImportSource.WORKSHOP,
};
