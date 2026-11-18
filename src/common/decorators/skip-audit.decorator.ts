import { SetMetadata } from '@nestjs/common';

export const SKIP_AUDIT_KEY = 'skipAudit';

/**
 * Bỏ route khỏi nhật ký hoạt động. Chỉ dành cho thao tác chỉ đổi trạng thái cá nhân của người xem
 * (đánh dấu đã đọc, dọn hộp thư) - ghi chúng làm loãng nhật ký mà không trả lời câu hỏi "ai đã đổi gì".
 * Gắn ở route thay vì thêm điều kiện đường dẫn vào AuditInterceptor, để interceptor vẫn không biết route nào.
 */
export const SkipAudit = () => SetMetadata(SKIP_AUDIT_KEY, true);
