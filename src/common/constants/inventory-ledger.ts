/** `InventoryTransaction.type` - what a ledger row records. The quantity is signed (+ in, - out) and every row moves exactly one lot. */
export const InventoryTxType = {
  IMPORT: 'IMPORT',
  TRANSFER_OUT: 'TRANSFER_OUT',
  TRANSFER_IN: 'TRANSFER_IN',
  /** Shipped but not received - the gap between a transfer's shipped and received quantities. */
  TRANSFER_LOSS: 'TRANSFER_LOSS',
  ADJUST: 'ADJUST',
  SALE: 'SALE',
  /** A packed sale cancelled before hand-over: the goods go back to the lots they came from. */
  SALE_REVERSAL: 'SALE_REVERSAL',
  RETURN_GOOD: 'RETURN_GOOD',
  RETURN_DAMAGED: 'RETURN_DAMAGED',
  /** Defective units from an import, put away at a damaged-goods location. */
  DEFECT: 'DEFECT',
  /** The stock that existed before lots did, opened once by the migration. */
  OPENING: 'OPENING',
} as const;

export type InventoryTxType =
  (typeof InventoryTxType)[keyof typeof InventoryTxType];

/** `InventoryTransaction.referenceType` - which document caused the row. */
export const InventoryRefType = {
  STOCK_MOVEMENT: 'STOCK_MOVEMENT',
  FULFILLMENT: 'FULFILLMENT',
  ORDER: 'ORDER',
  PRODUCTION_REQUEST: 'PRODUCTION_REQUEST',
  ORDER_RETURN: 'ORDER_RETURN',
  /** OPENING rows: the inventory row whose stock was turned into a lot. */
  INVENTORY: 'INVENTORY',
} as const;

export type InventoryRefType =
  (typeof InventoryRefType)[keyof typeof InventoryRefType];

/** `InventoryLot.sourceType` - where the goods originally came from. Carried unchanged when a lot is split by a transfer or a return, so margin per source survives every move. */
export const LotSourceType = {
  SUPPLIER: 'SUPPLIER',
  WORKSHOP: 'WORKSHOP',
  /** A stocktake surplus. */
  ADJUSTMENT: 'ADJUSTMENT',
  /** Stock that predates lots. */
  OPENING: 'OPENING',
} as const;

export type LotSourceType = (typeof LotSourceType)[keyof typeof LotSourceType];

/** `StockMovementRequest.importSource` - the two receiving flows, never mixed on one document. Set on IMPORT only (SQL CHECK). */
export const ImportSource = {
  SUPPLIER: 'SUPPLIER',
  WORKSHOP: 'WORKSHOP',
} as const;

export type ImportSource = (typeof ImportSource)[keyof typeof ImportSource];

export const IMPORT_SOURCES: readonly string[] = Object.values(ImportSource);

/** `Supplier.type`. A GOODS supplier sells finished goods (SUPPLIER imports); a WORKSHOP makes them to order (production requests + WORKSHOP imports). */
export const SupplierType = {
  GOODS: 'GOODS',
  WORKSHOP: 'WORKSHOP',
} as const;

export type SupplierType = (typeof SupplierType)[keyof typeof SupplierType];

export const SUPPLIER_TYPES: readonly string[] = Object.values(SupplierType);

/** The import flow each supplier type may feed. */
export const IMPORT_SOURCE_FOR_SUPPLIER_TYPE: Readonly<
  Record<SupplierType, ImportSource>
> = {
  [SupplierType.GOODS]: ImportSource.SUPPLIER,
  [SupplierType.WORKSHOP]: ImportSource.WORKSHOP,
};
