/** `tenant_banking_changes.source` (CHECK): ai đổi thông tin nhận tiền. */
export const TenantBankingChangeSource = {
  /** Chủ shop, qua `PUT /tenant/me` hoặc `PUT /tenant/banking`. */
  OWNER: 'OWNER',
  /** Admin nền tảng, qua `PUT /tenant/:id/sepay-key`. */
  ADMIN: 'ADMIN',
  /** Cron / nút đồng bộ SePay đánh dấu hoặc gỡ liên kết (không có người làm). */
  SEPAY_SYNC: 'SEPAY_SYNC',
} as const;

export type TenantBankingChangeSource =
  (typeof TenantBankingChangeSource)[keyof typeof TenantBankingChangeSource];
