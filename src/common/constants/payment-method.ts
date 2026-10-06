/** How money actually moved - the set CashFlow.paymentMethod documents in prisma/schema.prisma. */
export const PaymentMethod = {
  CASH: 'CASH',
  BANK_TRANSFER: 'BANK_TRANSFER',
  MOMO: 'MOMO',
  VNPAY: 'VNPAY',
  SEPAY: 'SEPAY',
} as const;

export type PaymentMethod = (typeof PaymentMethod)[keyof typeof PaymentMethod];

export const PAYMENT_METHODS: readonly string[] = Object.values(PaymentMethod);

/** `Payment.kind`: what a payment row is for. An order can collect several (contract §2): a DEPOSIT when it is taken, a BALANCE on delivery; FULL is a sale paid at once, REFUND money going back. */
export const PaymentKind = {
  FULL: 'FULL',
  DEPOSIT: 'DEPOSIT',
  BALANCE: 'BALANCE',
  REFUND: 'REFUND',
} as const;

export type PaymentKind = (typeof PaymentKind)[keyof typeof PaymentKind];

/** `Payment.status` - one payment row's own state, not the order's `paymentStatus` (which is derived from these rows). */
export const PaymentRecordStatus = {
  PENDING: 'PENDING',
  PAID: 'PAID',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
} as const;

export type PaymentRecordStatus =
  (typeof PaymentRecordStatus)[keyof typeof PaymentRecordStatus];

/**
 * Cách shipper thu số tiền còn phải thu khi giao (`POST /shipments/:id/deliver`, C-5). Khác `PaymentMethod`
 * vì đây là lựa chọn của shipper trên màn hình: `BANK_TRANSFER_QR` ghi thành khoản SEPAY chờ webhook,
 * `NONE` là đã cọc đủ – không ghi khoản nào.
 */
export const DeliveryCollectionMethod = {
  CASH: 'CASH',
  BANK_TRANSFER_QR: 'BANK_TRANSFER_QR',
  NONE: 'NONE',
} as const;

export type DeliveryCollectionMethod =
  (typeof DeliveryCollectionMethod)[keyof typeof DeliveryCollectionMethod];

export const DELIVERY_COLLECTION_METHODS: readonly string[] = Object.values(
  DeliveryCollectionMethod,
);

/** How a deposit can be taken when a manual order is created (contract §2 `deposit.method`). */
export const DEPOSIT_METHODS: readonly string[] = [
  PaymentMethod.CASH,
  PaymentMethod.BANK_TRANSFER,
];
