/** Các loại thông báo hệ thống được hiện trong feed admin. */
export const SystemNotificationType = {
  TRANSACTION: 'SYSTEM_TRANSACTION',
  TENANT_CREATED: 'SYSTEM_TENANT_CREATED',
  TICKET_CREATED: 'SYSTEM_TICKET_CREATED',
  TENANT_BANK_UPDATED: 'SYSTEM_TENANT_BANK_UPDATED',
  /** Tiền SePay về tài khoản không thuộc shop nào (sổ `sepay_transactions` không có tenant). */
  SEPAY_UNMATCHED: 'SYSTEM_SEPAY_UNMATCHED',
  /** Tiền gói về tài khoản iKiot nhưng không kích hoạt được gói. */
  PLATFORM_TRANSFER_NEEDS_ACTION: 'SYSTEM_PLATFORM_TRANSFER_NEEDS_ACTION',
} as const;

export const SYSTEM_NOTIFICATION_TYPES: string[] = Object.values(
  SystemNotificationType,
);

/** Thông báo gửi chủ shop, không vào feed. */
export const ANNOUNCEMENT_TYPE = 'ANNOUNCEMENT';

/** Đối tượng nhận thông báo. Chỉ `SELECTION` mới đọc `targetTenants`. */
export const AnnouncementTarget = {
  ALL: 'ALL',
  SELECTION: 'SELECTION',
} as const;

export const ANNOUNCEMENT_TARGETS: string[] = Object.values(AnnouncementTarget);

/** Gợi ý loại thông báo cho admin UI. */
export const KNOWN_ANNOUNCEMENT_CATEGORIES = [
  'Maintenance',
  'New feature',
  'Promotion',
  'Security',
];
