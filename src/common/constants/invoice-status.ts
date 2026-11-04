/** `Invoice.status`. PENDING tới khi đơn COMPLETED; CANCELLED chỉ từ PENDING (hoá đơn ISSUED được sửa bằng ADJUSTMENT, không bao giờ huỷ ngược). */
export const InvoiceStatus = {
  PENDING: 'PENDING',
  ISSUED: 'ISSUED',
  CANCELLED: 'CANCELLED',
} as const;
export type InvoiceStatus = (typeof InvoiceStatus)[keyof typeof InvoiceStatus];

/** `Invoice.type`. ADJUSTMENT mang tổng âm và trỏ tới SALE mà nó sửa. */
export const InvoiceType = {
  SALE: 'SALE',
  ADJUSTMENT: 'ADJUSTMENT',
} as const;
export type InvoiceType = (typeof InvoiceType)[keyof typeof InvoiceType];

/** Tiền tố số hoá đơn; phần số là bộ đếm chạy theo từng shop và từng tiền tố. */
export const INVOICE_NUMBER_PREFIX = {
  [InvoiceType.SALE]: 'HD',
  [InvoiceType.ADJUSTMENT]: 'DC',
} as const;
