/** `InventoryTransaction.type` - loại dòng sổ cái. Số lượng có dấu (+ vào, - ra); mỗi dòng chỉ tác động đúng một lot. */
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
  RETURN_DAMAGED: 'RETURN_DAMAGED',
  /** Hàng lỗi từ phiếu nhập, được đưa vào kho hàng hỏng. */
  DEFECT: 'DEFECT',
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
  /** Dòng OPENING: dòng inventory có tồn kho đã chuyển thành lot. */
  INVENTORY: 'INVENTORY',
} as const;

export type InventoryRefType =
  (typeof InventoryRefType)[keyof typeof InventoryRefType];

/** `InventoryLot.sourceType` - hàng gốc từ đâu. Giữ nguyên khi lot bị tách do chuyển kho hoặc trả hàng, để biên lợi nhuận theo nguồn không đổi qua các lần di chuyển. */
export const LotSourceType = {
  SUPPLIER: 'SUPPLIER',
  WORKSHOP: 'WORKSHOP',
  /** Hàng dư khi kiểm kê. */
  ADJUSTMENT: 'ADJUSTMENT',
  /** Tồn kho có trước khi có lot. */
  OPENING: 'OPENING',
} as const;

export type LotSourceType = (typeof LotSourceType)[keyof typeof LotSourceType];

/** `StockMovementRequest.importSource` - hai luồng nhận hàng, không bao giờ lẫn trên một chứng từ. Chỉ đặt cho IMPORT (SQL CHECK). */
export const ImportSource = {
  SUPPLIER: 'SUPPLIER',
  WORKSHOP: 'WORKSHOP',
} as const;

export type ImportSource = (typeof ImportSource)[keyof typeof ImportSource];

export const IMPORT_SOURCES: readonly string[] = Object.values(ImportSource);

/** `Supplier.type`. GOODS bán thành phẩm (nhập SUPPLIER); WORKSHOP làm theo đơn (yêu cầu sản xuất + nhập WORKSHOP). */
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
