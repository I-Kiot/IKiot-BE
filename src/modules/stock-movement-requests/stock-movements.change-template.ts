import {
  ChangeAction,
  ChangeResource,
} from '../../common/constants/change-feed';
import type {
  ChangeExtractContext,
  ChangeSpec,
  ChangeTarget,
} from '../../common/realtime/change-feed.types';
import { readRef, readString } from '../../common/realtime/change-ref';

/** Nội dung feed `entity:changed` của phiếu kho. */

/** Danh từ theo loại phiếu - cùng nhãn FE hiện ở bảng (`transfers-columns`, `movement-detail-header`). */
const MOVEMENT_NOUN: Readonly<Record<string, string>> = {
  EXPORT: 'phiếu chuyển kho',
  RETURN: 'phiếu trả hàng',
  ADJUST: 'phiếu kiểm kê',
  IMPORT: 'phiếu nhập hàng',
};

/** Nhãn phiếu: `<loại> #<6 ký tự cuối id>`. */
export function movementLabel(id: string, movementType: string | null): string {
  const noun = (movementType && MOVEMENT_NOUN[movementType]) || 'phiếu kho';
  return `${noun} #${id.slice(-6).toUpperCase()}`;
}

/** Đọc id và loại phiếu từ body. */
export function movementTarget({
  body,
  params,
}: ChangeExtractContext): ChangeTarget {
  const ref = readRef(body);
  const id = params.id ?? ref?.id ?? null;
  return {
    subjectId: id,
    code: id ? movementLabel(id, readString(body, 'movementType')) : null,
  };
}

const movementSpec = (
  action: ChangeAction,
  verb: string,
  also: readonly ChangeResource[] = [],
): ChangeSpec => ({
  action,
  subject: ChangeResource.STOCK_MOVEMENTS,
  also,
  extract: movementTarget,
  // `code` đã là nhãn đầy đủ ("phiếu chuyển kho #A1B2C3").
  summary: ({ actor, code }) =>
    `${actor} vừa ${verb} ${code ?? 'một phiếu kho'}`,
});

const STOCK = [ChangeResource.INVENTORIES] as const;

export const StockMovementChanges = {
  created: movementSpec(ChangeAction.STOCK_MOVEMENT_CREATED, 'tạo'),
  edited: movementSpec(ChangeAction.STOCK_MOVEMENT_EDITED, 'sửa'),
  opened: movementSpec(ChangeAction.STOCK_MOVEMENT_OPENED, 'mở'),
  closed: movementSpec(ChangeAction.STOCK_MOVEMENT_CLOSED, 'chốt'),
  shipped: movementSpec(
    ChangeAction.STOCK_MOVEMENT_SHIPPED,
    'xuất hàng',
    STOCK,
  ),
  received: movementSpec(
    ChangeAction.STOCK_MOVEMENT_RECEIVED,
    'nhận hàng',
    STOCK,
  ),
  adjustApproved: movementSpec(
    ChangeAction.STOCK_MOVEMENT_ADJUST_APPROVED,
    'duyệt',
    STOCK,
  ),
  cancelled: movementSpec(ChangeAction.STOCK_MOVEMENT_CANCELLED, 'huỷ', STOCK),
} satisfies Record<string, ChangeSpec>;
