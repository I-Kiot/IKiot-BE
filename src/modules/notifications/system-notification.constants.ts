/** Thông báo hệ thống: row có `tenantId` và `recipientId` đều null. Whitelist type này là lớp lọc thứ hai, để type mới của `notifySystem` không tự động lọt vào feed của operator. */
export const SystemNotificationType = {
  TRANSACTION: 'SYSTEM_TRANSACTION',
  TENANT_CREATED: 'SYSTEM_TENANT_CREATED',
  TICKET_CREATED: 'SYSTEM_TICKET_CREATED',
  TENANT_BANK_UPDATED: 'SYSTEM_TENANT_BANK_UPDATED',
  /** Tiền SePay về tài khoản không thuộc shop nào (sổ `sepay_transactions` không có tenant). */
  SEPAY_UNMATCHED: 'SYSTEM_SEPAY_UNMATCHED',
  /** Tiền về tài khoản iKiot (tenant trả tiền gói) nhưng không kích hoạt được gói: chuyển thiếu, hoá đơn không còn chờ, không có mã / mã lạ (sổ `platform_sepay_transactions`). */
  PLATFORM_TRANSFER_NEEDS_ACTION: 'SYSTEM_PLATFORM_TRANSFER_NEEDS_ACTION',
} as const;

export const SYSTEM_NOTIFICATION_TYPES: string[] = Object.values(
  SystemNotificationType,
);

/** Announcement không phải sự kiện hệ thống, không bao giờ xuất hiện trong feed; row chỉ lưu lại việc đã gửi. */
export const ANNOUNCEMENT_TYPE = 'ANNOUNCEMENT';

/** Đối tượng nhận thông báo. Chỉ `SELECTION` mới đọc `targetTenants`. */
export const AnnouncementTarget = {
  ALL: 'ALL',
  SELECTION: 'SELECTION',
} as const;

export const ANNOUNCEMENT_TARGETS: string[] = Object.values(AnnouncementTarget);

/** Bốn category admin UI đưa ra làm gợi ý, không phải whitelist validate: giá trị là free text được in thẳng vào tiêu đề email. */
export const KNOWN_ANNOUNCEMENT_CATEGORIES = [
  'Maintenance',
  'New feature',
  'Promotion',
  'Security',
];
