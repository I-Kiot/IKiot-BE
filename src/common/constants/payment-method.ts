/** Tiền thực sự đi bằng cách nào - bộ giá trị mà CashFlow.paymentMethod ghi trong prisma/schema.prisma. */
export const PaymentMethod = {
  CASH: 'CASH',
  BANK_TRANSFER: 'BANK_TRANSFER',
  MOMO: 'MOMO',
  VNPAY: 'VNPAY',
  SEPAY: 'SEPAY',
} as const;

export type PaymentMethod = (typeof PaymentMethod)[keyof typeof PaymentMethod];

export const PAYMENT_METHODS: readonly string[] = Object.values(PaymentMethod);

/** `Payment.kind`: loại khoản thanh toán. Một đơn có thể có nhiều khoản (hợp đồng §2): DEPOSIT khi nhận cọc, BALANCE khi giao; FULL là thanh toán một lần, REFUND là tiền trả lại khách. */
export const PaymentKind = {
  FULL: 'FULL',
  DEPOSIT: 'DEPOSIT',
  BALANCE: 'BALANCE',
  REFUND: 'REFUND',
} as const;

export type PaymentKind = (typeof PaymentKind)[keyof typeof PaymentKind];

/** `Payment.status` - trạng thái riêng của một khoản, không phải `paymentStatus` của đơn (đơn suy ra từ các khoản này). */
export const PaymentRecordStatus = {
  PENDING: 'PENDING',
  PAID: 'PAID',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
} as const;

export type PaymentRecordStatus =
  (typeof PaymentRecordStatus)[keyof typeof PaymentRecordStatus];

/**
 * Cách shipper thu số tiền còn phải thu khi giao (`POST /shipments/:id/deliver`). Khác `PaymentMethod` vì đây là lựa chọn trên màn hình: `BANK_TRANSFER_QR` ghi thành khoản SEPAY chờ webhook, `NONE` là đã cọc đủ, không ghi khoản nào.
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

/** Cách nhận cọc khi tạo đơn thủ công (hợp đồng §2, `deposit.method`). */
export const DEPOSIT_METHODS: readonly string[] = [
  PaymentMethod.CASH,
  PaymentMethod.BANK_TRANSFER,
];
