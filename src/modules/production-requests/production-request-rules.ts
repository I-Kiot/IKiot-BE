import {
  FINAL_PRODUCTION_REQUEST_STATUSES,
  ProductionRequestStatus,
} from '../../common/constants/production-request-status';
import { ErrorCode } from '../../common/errors/error-codes';

// Vòng đời yêu cầu sản xuất dưới dạng hàm thuần, là nơi duy nhất quyết mọi đổi trạng thái (contract §3); test trong production-request-rules.spec.ts.
//
//   DRAFT ──SENT──▶ SENT ──receive──▶ PARTIALLY_RECEIVED ──receive──▶ COMPLETED
//     │               │                       │
//     └──CANCELLED◀───┘                       └──đóng thiếu (bằng tay, kèm lý do)──▶ COMPLETED
//        (chỉ khi chưa nhận gì)
//
// Đóng thiếu có vì xưởng giao 8/10 rồi dừng sẽ khiến yêu cầu mở mãi, 2 cái còn lại vẫn bị tính "đang đặt" trên danh sách sản xuất,
// nên thiếu đáng lẽ phải hiện thì vẫn bị ẩn. Khi đã đóng, phần còn lại thôi được tính và danh sách hiện lại SKU đó thiếu, sẵn để đặt chỗ khác.

export type RuleViolation = { code: ErrorCode; message: string };

/** Trạng thái do người dùng đặt tay. Trả lý do bị từ chối hoặc null. Yêu cầu đã giao hàng không được huỷ: tồn đã nhập theo nó, huỷ sẽ mất dấu nguồn hàng; thay vào đó đóng thiếu, giữ các phiếu nhận và bỏ phần chưa về. */
export function manualTransitionViolation(
  from: string,
  to: string,
  receivedAny: boolean,
  reason?: string | null,
): RuleViolation | null {
  if (FINAL_PRODUCTION_REQUEST_STATUSES.includes(from)) {
    return {
      code: ErrorCode.PRODUCTION_REQUEST_STATUS_INVALID,
      message: `A ${from} production request cannot change status`,
    };
  }
  if (to === ProductionRequestStatus.SENT) {
    return from === ProductionRequestStatus.DRAFT
      ? null
      : {
          code: ErrorCode.PRODUCTION_REQUEST_STATUS_INVALID,
          message: 'Only a DRAFT production request can be sent',
        };
  }
  if (to === ProductionRequestStatus.CANCELLED) {
    return receivedAny
      ? {
          code: ErrorCode.PRODUCTION_REQUEST_HAS_RECEIPTS,
          message:
            'Goods have already been received against this production request; close it short instead of cancelling',
        }
      : null;
  }
  if (to === ProductionRequestStatus.COMPLETED) {
    // Chỉ yêu cầu đã giao gì đó và còn nợ phần còn lại. Chưa nhận gì là huỷ, không phải đóng thiếu.
    if (from !== ProductionRequestStatus.PARTIALLY_RECEIVED) {
      return {
        code: ErrorCode.PRODUCTION_REQUEST_STATUS_INVALID,
        message:
          'Only a partly received production request can be closed short; cancel one that has received nothing',
      };
    }
    return reason?.trim()
      ? null
      : {
          code: ErrorCode.PRODUCTION_REQUEST_CLOSE_REASON_REQUIRED,
          message: 'Closing a production request short needs a reason (note)',
        };
  }
  return {
    code: ErrorCode.PRODUCTION_REQUEST_STATUS_INVALID,
    message: `${to} follows from receiving goods and cannot be set by hand`,
  };
}

/** Sau một lần nhận, yêu cầu ở đâu: COMPLETED khi mọi dòng đủ số đã đặt, còn lại PARTIALLY_RECEIVED. */
export function statusAfterReceipt(
  lines: { quantity: number; receivedQuantity: number }[],
): string {
  return lines.every((line) => line.receivedQuantity >= line.quantity)
    ? ProductionRequestStatus.COMPLETED
    : ProductionRequestStatus.PARTIALLY_RECEIVED;
}

/** Mã YCSX kế tiếp sau mã cao nhất của shop: `YCSX000123` → `YCSX000124`. Mã luôn do server tạo nên khớp mẫu; mã khác bị bỏ qua chứ không tin. */
export const PRODUCTION_REQUEST_CODE_PREFIX = 'YCSX';

export function nextProductionRequestCode(
  existing: string | null | undefined,
  step = 1,
): string {
  const digits = existing?.startsWith(PRODUCTION_REQUEST_CODE_PREFIX)
    ? existing.slice(PRODUCTION_REQUEST_CODE_PREFIX.length)
    : '';
  const current = /^\d+$/.test(digits) ? Number(digits) : 0;
  return `${PRODUCTION_REQUEST_CODE_PREFIX}${String(current + step).padStart(6, '0')}`;
}
