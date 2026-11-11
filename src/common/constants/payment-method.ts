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
  /** Tiền thối khi bán tại quầy: tiền ra cho khách, trỏ về khoản FULL của lần bán (ghi từ Phase 3). Tính vào số tiền ra như hoàn tiền (xem payment-status.ts). */
  CHANGE: 'CHANGE',
} as const;

export type PaymentKind = (typeof PaymentKind)[keyof typeof PaymentKind];

/**
 * `Payment.status` - trạng thái riêng của một khoản, không phải `paymentStatus` của đơn (đơn suy ra từ các khoản này).
 * EXPIRED do cron đặt cho khoản QR SePay đã quá hạn (`sepay-qr-expiry.cron.ts`); giữa lúc hết hạn và lượt cron kế tiếp khoản vẫn là PENDING, nên chỗ nào cần biết "còn hạn không" phải dùng `isQrExpired`, không đọc status.
 */
export const PaymentRecordStatus = {
  PENDING: 'PENDING',
  PAID: 'PAID',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED',
} as const;

export type PaymentRecordStatus =
  (typeof PaymentRecordStatus)[keyof typeof PaymentRecordStatus];

/** Khoản QR còn "mở": chưa thu, chưa huỷ. Hết hạn rồi vẫn là mở (tiền về muộn vẫn chốt được, và phải huỷ khi đổi sang tiền mặt hay phát lại mã). */
export const OPEN_QR_PAYMENT_STATUSES: readonly string[] = [
  PaymentRecordStatus.PENDING,
  PaymentRecordStatus.EXPIRED,
];

/** `sepay_transactions.outcome`: kết cục của một giao dịch SePay đã nhận (CHECK `sepay_transactions_outcome_check`). */
export const SepayTransactionOutcome = {
  SETTLED: 'SETTLED',
  /** Chốt được dù mã QR đã hết hạn, vì đơn / khoản vẫn đang chờ đúng khoản tiền này. */
  SETTLED_LATE: 'SETTLED_LATE',
  /** Chuyển thiếu so với số mã QR yêu cầu: khoản thành PAID với số tiền thực nhận, đơn chưa đủ tiền nên chưa chốt (PARTIALLY_PAID). */
  SETTLED_PARTIAL: 'SETTLED_PARTIAL',
  /** Tiền đã về nhưng không chốt được vì đơn / khoản không còn chờ: không đổi đơn, ghi sổ thu chi `UNALLOCATED_RECEIPT`, báo chủ shop hoàn / đối soát. */
  REJECTED: 'REJECTED',
  /** Tiền đã về nhưng không gắn được đơn nào (không có mã, mã lạ, tài khoản không thuộc shop nào): ghi sổ thu chi `UNALLOCATED_RECEIPT` (trừ khi không biết shop), báo chủ shop. */
  UNMATCHED: 'UNMATCHED',
} as const;

export type SepayTransactionOutcome =
  (typeof SepayTransactionOutcome)[keyof typeof SepayTransactionOutcome];

/** `sepay_transactions.reject_reason` khi outcome là REJECTED. */
export const SepayRejectReason = {
  /** Đơn quầy đã bị huỷ (tay hoặc cron QR hết hạn). */
  ORDER_CANCELLED: 'ORDER_CANCELLED',
  /** Đã thu đủ rồi (đơn quầy COMPLETED, hoặc khoản đã PAID bằng giao dịch khác). */
  ALREADY_PAID: 'ALREADY_PAID',
  /** Khoản bị huỷ: shipper chuyển tiền mặt, phát lại mã mới, hay đơn bị huỷ. */
  PAYMENT_SUPERSEDED: 'PAYMENT_SUPERSEDED',
  /** Khoản còn mở nhưng đơn không còn ở bước chờ khoản này. */
  ORDER_NOT_WAITING: 'ORDER_NOT_WAITING',
  /** UNMATCHED: nội dung chuyển khoản không có mã đơn (ORD…). */
  NO_REFERENCE: 'NO_REFERENCE',
  /** UNMATCHED: có mã đơn nhưng không khoản thanh toán nào của shop mang mã đó. */
  UNKNOWN_REFERENCE: 'UNKNOWN_REFERENCE',
  /** UNMATCHED: tài khoản nhận không thuộc shop nào (chỉ ghi khi webhook dùng key dùng chung). */
  UNKNOWN_TENANT: 'UNKNOWN_TENANT',
} as const;

export type SepayRejectReason =
  (typeof SepayRejectReason)[keyof typeof SepayRejectReason];

/** `sepay_transactions.resolution`: cách chủ shop xử lý xong một giao dịch SePay chưa chốt (CHECK `sepay_transactions_resolution_check`). */
export const SepayResolution = {
  /** Đã hoàn tiền ngoài hệ thống; ghi sổ thu chi `UNALLOCATED_REFUND` nếu khoản đó đã vào sổ là `UNALLOCATED_RECEIPT`. */
  REFUNDED_MANUALLY: 'REFUNDED_MANUALLY',
  /** Đã đối chiếu thủ công với một đơn / khoản; không ghi thêm gì (tiền đã nằm trong sổ). */
  MATCHED_MANUALLY: 'MATCHED_MANUALLY',
  /** Không cần xử lý (vd. chuyển nhầm đã báo ngân hàng). */
  IGNORED: 'IGNORED',
} as const;

export type SepayResolution =
  (typeof SepayResolution)[keyof typeof SepayResolution];

export const SEPAY_RESOLUTIONS: readonly string[] =
  Object.values(SepayResolution);

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

/** Cách thu số còn lại khi khách tới lấy hàng tại quầy (`POST /orders/:id/pickup/collect`). Không có `NONE`: đã đủ tiền thì không cần thu. */
export const PICKUP_COLLECTION_METHODS: readonly string[] = [
  DeliveryCollectionMethod.CASH,
  DeliveryCollectionMethod.BANK_TRANSFER_QR,
];

/** Cách hoàn tiền cho khách khi kiểm hàng trả / hoàn phần trả dư: tiền mặt (ra khỏi quỹ chi nhánh bán đơn) hoặc chuyển khoản. SePay chỉ báo tiền vào nên không phải một cách hoàn. */
export const REFUND_METHODS = ['CASH', 'BANK_TRANSFER'] as const;
