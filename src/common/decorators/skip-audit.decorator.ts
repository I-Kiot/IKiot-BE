import { SetMetadata } from '@nestjs/common';

export const SKIP_AUDIT_KEY = 'skipAudit';

/** Bỏ route khỏi nhật ký hoạt động, chỉ cho thao tác cá nhân như đánh dấu đã đọc. */
export const SkipAudit = () => SetMetadata(SKIP_AUDIT_KEY, true);
