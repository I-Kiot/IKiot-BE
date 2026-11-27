/** Loại bút toán sổ bán hàng. */
export const SalesJournalEntryType = {
  /** Ghi một lần mỗi đơn khi đơn COMPLETED. */
  SALE: 'SALE',
  /** Hàng trả sau khi đã có SALE: số ÂM, ghi vào kỳ lúc trả hàng, không sửa kỳ cũ. */
  RETURN: 'RETURN',
  /** Shop giữ tiền của đơn không thành (huỷ / trả trước khi hoàn thành): "thu nhập khác", số dương. */
  OTHER_INCOME: 'OTHER_INCOME',
} as const;

export type SalesJournalEntryType =
  (typeof SalesJournalEntryType)[keyof typeof SalesJournalEntryType];

/** `sales_journal_entries.source`: nơi ghi bút toán (để truy ngược khi đối soát). */
export const SalesJournalSource = {
  POS_SALE: 'POS_SALE',
  POS_PAY_OFFLINE: 'POS_PAY_OFFLINE',
  SEPAY_WEBHOOK: 'SEPAY_WEBHOOK',
  DELIVERY: 'DELIVERY',
  REMITTANCE: 'REMITTANCE',
  PICKUP_HAND_OVER: 'PICKUP_HAND_OVER',
  RETURN_INSPECTION: 'RETURN_INSPECTION',
  POS_RETURN: 'POS_RETURN',
  ORDER_CANCEL: 'ORDER_CANCEL',
  POS_CANCEL: 'POS_CANCEL',
  RETURN_KEPT: 'RETURN_KEPT',
  /** Chủ shop giữ tiền treo, ghi theo ngày quyết định. */
  HELD_DECISION: 'HELD_DECISION',
} as const;

export type SalesJournalSource =
  (typeof SalesJournalSource)[keyof typeof SalesJournalSource];
