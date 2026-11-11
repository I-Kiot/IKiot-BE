/** `supplier_debt_entries.entry_type` (CHECK `supplier_debt_entries_type_check`). Dấu của `amount` đi theo loại: PAYMENT âm, hai loại kia dương. */
export const SupplierDebtEntryType = {
  /** Dư nợ có sẵn lúc bật sổ (migration 20261111140000). */
  OPENING: 'OPENING',
  /** Nhận hàng từ NCC / xưởng: nợ tăng. */
  CHARGE: 'CHARGE',
  /** Trả nợ: nợ giảm. */
  PAYMENT: 'PAYMENT',
} as const;

export type SupplierDebtEntryType =
  (typeof SupplierDebtEntryType)[keyof typeof SupplierDebtEntryType];

/** `supplier_debt_entries.reference_type`: chứng từ làm nợ đổi. */
export const SupplierDebtRefType = {
  STOCK_MOVEMENT: 'STOCK_MOVEMENT',
  PRODUCTION_REQUEST: 'PRODUCTION_REQUEST',
  CASH_FLOW: 'CASH_FLOW',
} as const;

export type SupplierDebtRefType =
  (typeof SupplierDebtRefType)[keyof typeof SupplierDebtRefType];

/** Ai / chứng từ nào làm nợ đổi. `actorId` null = hệ thống. */
export interface SupplierDebtRef {
  actorId: string | null;
  type: SupplierDebtRefType;
  id: string;
  code?: string | null;
}
