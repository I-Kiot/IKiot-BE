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

/** Loại khoản thanh toán: cọc, phần còn lại, trả một lần, hoàn tiền. */
export const PaymentKind = {
  FULL: 'FULL',
  DEPOSIT: 'DEPOSIT',
  BALANCE: 'BALANCE',
  REFUND: 'REFUND',
  /** Tiền thối khi bán tại quầy, tính như tiền ra. */
  CHANGE: 'CHANGE',
} as const;

export type PaymentKind = (typeof PaymentKind)[keyof typeof PaymentKind];

/** Trạng thái riêng của một khoản thanh toán; kiểm hạn QR dùng `isQrExpired`, không đọc status. */
export const PaymentRecordStatus = {
  PENDING: 'PENDING',
  PAID: 'PAID',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED',
} as const;

export type PaymentRecordStatus =
  (typeof PaymentRecordStatus)[keyof typeof PaymentRecordStatus];

/** Khoản QR còn mở: chưa thu, chưa huỷ, kể cả đã hết hạn. */
export const OPEN_QR_PAYMENT_STATUSES: readonly string[] = [
  PaymentRecordStatus.PENDING,
  PaymentRecordStatus.EXPIRED,
];

/** Kết quả xử lý một giao dịch SePay đã nhận. */
export const SepayTransactionOutcome = {
  SETTLED: 'SETTLED',
  /** Chốt được dù mã QR đã hết hạn, vì đơn / khoản vẫn đang chờ đúng khoản tiền này. */
  SETTLED_LATE: 'SETTLED_LATE',
  /** Chuyển thiếu: khoản PAID theo số thực nhận, đơn chưa chốt. */
  SETTLED_PARTIAL: 'SETTLED_PARTIAL',
  /** Tiền về nhưng đơn không còn chờ: ghi tiền chưa phân bổ, báo chủ shop. */
  REJECTED: 'REJECTED',
  /** Tiền về nhưng không gắn được đơn: ghi tiền chưa phân bổ, báo chủ shop. */
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

/** Cách chủ shop xử lý giao dịch SePay chưa chốt. */
export const SepayResolution = {
  /** Đã hoàn tiền ngoài hệ thống, ghi chi nếu trước đó đã ghi thu chưa phân bổ. */
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

/** Cách shipper thu số còn lại khi giao: tiền mặt, QR, hoặc không thu. */
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

/** Cách thu số còn lại khi khách lấy hàng tại quầy. */
export const PICKUP_COLLECTION_METHODS: readonly string[] = [
  DeliveryCollectionMethod.CASH,
  DeliveryCollectionMethod.BANK_TRANSFER_QR,
];

/** Cách hoàn tiền cho khách: tiền mặt hoặc chuyển khoản. */
export const REFUND_METHODS = ['CASH', 'BANK_TRANSFER'] as const;
