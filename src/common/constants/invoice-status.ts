/** `Invoice.status`. PENDING until the order is COMPLETED; CANCELLED only ever from PENDING (an ISSUED invoice is corrected with an ADJUSTMENT, never undone). */
export const InvoiceStatus = {
  PENDING: 'PENDING',
  ISSUED: 'ISSUED',
  CANCELLED: 'CANCELLED',
} as const;
export type InvoiceStatus = (typeof InvoiceStatus)[keyof typeof InvoiceStatus];

/** `Invoice.type`. An ADJUSTMENT carries a negative total and points at the SALE it corrects. */
export const InvoiceType = {
  SALE: 'SALE',
  ADJUSTMENT: 'ADJUSTMENT',
} as const;
export type InvoiceType = (typeof InvoiceType)[keyof typeof InvoiceType];

/** Number prefixes; the digits are a per-shop, per-prefix running count. */
export const INVOICE_NUMBER_PREFIX = {
  [InvoiceType.SALE]: 'HD',
  [InvoiceType.ADJUSTMENT]: 'DC',
} as const;
