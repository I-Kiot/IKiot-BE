import {
  FINAL_PRODUCTION_REQUEST_STATUSES,
  ProductionRequestStatus,
} from '../../common/constants/production-request-status';
import { ErrorCode } from '../../common/errors/error-codes';
import type { OrderableLine } from './production-orderable';

// Vòng đời YCSX: nháp → gửi → nhận một phần → hoàn tất, hoặc huỷ / đóng thiếu.

export type RuleViolation = { code: ErrorCode; message: string };

/** Kiểm đổi trạng thái tay, trả lý do từ chối hoặc null. */
export function manualTransitionViolation(
  from: string,
  to: string,
  receivedAny: boolean,
  reason?: string | null,
  workshop: { acceptedByWorkshop: boolean; cancelledByWorkshop: boolean } = {
    acceptedByWorkshop: false,
    cancelledByWorkshop: false,
  },
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
    // Đã nhận hàng thì báo lý do đó trước: ai huỷ cũng không gỡ được.
    const shopBlocked =
      workshop.acceptedByWorkshop && !workshop.cancelledByWorkshop;
    if (!receivedAny && shopBlocked) {
      return {
        code: ErrorCode.PRODUCTION_REQUEST_IN_PRODUCTION,
        message:
          'The workshop has confirmed it is making this request; only the workshop can cancel it now',
      };
    }
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

/** Mã YCSX kế tiếp. */
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

/** Phần dòng đơn còn cần làm, null nếu không biết. */
export function remainingNeedOf(
  line: { isCustom: boolean; quantity: number },
  shortQuantity: number | null,
): number | null {
  if (line.isCustom) return line.quantity;
  return shortQuantity;
}

export interface ProductionExcess {
  orderItemId: string;
  need: number;
  alreadyOpen: number;
  requested: number;
  orderable: number;
  /** Loại vượt: vượt dòng (LINE) hay vượt số thiếu chung (POOL). */
  scope: 'LINE' | 'POOL';
}

/** Kiểm số đặt xưởng không vượt phần còn đặt được. */
export function productionExcessOf(
  requested: readonly { orderItemId: string | null; quantity: number }[],
  lines: ReadonlyMap<
    string,
    Pick<
      OrderableLine,
      'need' | 'covered' | 'orderable' | 'poolKey' | 'poolShort'
    >
  >,
): ProductionExcess | null {
  const wanted = new Map<string, number>();
  for (const line of requested) {
    if (!line.orderItemId) continue;
    wanted.set(
      line.orderItemId,
      (wanted.get(line.orderItemId) ?? 0) + line.quantity,
    );
  }
  const pools = new Map<
    string,
    { first: string; total: number; short: number }
  >();
  for (const [orderItemId, quantity] of wanted) {
    const line = lines.get(orderItemId);
    if (!line || line.orderable === null) continue;
    if (quantity > line.orderable) {
      return {
        orderItemId,
        need: line.need ?? 0,
        alreadyOpen: line.covered,
        requested: quantity,
        orderable: line.orderable,
        scope: 'LINE',
      };
    }
    const pool = pools.get(line.poolKey);
    if (pool) pool.total += quantity;
    else
      pools.set(line.poolKey, {
        first: orderItemId,
        total: quantity,
        short: line.poolShort,
      });
  }
  for (const pool of pools.values()) {
    if (pool.total > pool.short) {
      const line = lines.get(pool.first)!;
      return {
        orderItemId: pool.first,
        need: line.need ?? 0,
        alreadyOpen: line.covered,
        requested: pool.total,
        orderable: pool.short,
        scope: 'POOL',
      };
    }
  }
  return null;
}
