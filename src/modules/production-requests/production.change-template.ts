import {
  ChangeAction,
  ChangeResource,
} from '../../common/constants/change-feed';
import type {
  ChangeExtractContext,
  ChangeSpec,
  ChangeTarget,
} from '../../common/realtime/change-feed.types';
import {
  named,
  readIdList,
  readRef,
  readRefOf,
  readString,
} from '../../common/realtime/change-ref';

/** Nội dung feed `entity:changed` của yêu cầu sản xuất (YCSX) và phiếu giao của xưởng. Chỉ tên người làm + động từ + mã chứng từ. */

/** Đơn nằm trong YCSX (qua `items[].orderItem.orderId`); `toResponse` luôn trả các dòng. */
function ordersOf(body: unknown): string[] {
  return readIdList(body, ['items', 'orderItem', 'orderId']);
}

/** Body là một YCSX; có thể kèm `stockMovementId` khi là route nhận hàng. */
export function productionRequestTarget({
  body,
  params,
}: ChangeExtractContext): ChangeTarget {
  const ref = readRef(body);
  return {
    subjectId: params.id ?? ref?.id ?? null,
    code: ref?.code ?? null,
    related: {
      [ChangeResource.ORDERS]: ordersOf(body),
      [ChangeResource.STOCK_MOVEMENTS]: [readString(body, 'stockMovementId')],
    },
  };
}

/** Phiếu giao của xưởng: `{ id, code, productionRequest: { id, code } }`. */
export function deliveryTarget({
  body,
  params,
}: ChangeExtractContext): ChangeTarget {
  const delivery = readRef(body);
  const request = readRefOf(body, 'productionRequest');
  return {
    subjectId: params.id ?? delivery?.id ?? null,
    code: delivery?.code ?? null,
    related: { [ChangeResource.PRODUCTION_REQUESTS]: [request?.id] },
  };
}

/** Nhận phiếu giao trả một YCSX (+ `stockMovementId`), còn `:id` là phiếu giao; mã trong câu là mã YCSX. */
export function deliveryReceiveTarget({
  body,
  params,
}: ChangeExtractContext): ChangeTarget {
  const request = readRef(body);
  return {
    subjectId: params.id ?? null,
    code: request?.code ?? null,
    related: {
      [ChangeResource.PRODUCTION_REQUESTS]: [request?.id],
      [ChangeResource.ORDERS]: ordersOf(body),
      [ChangeResource.STOCK_MOVEMENTS]: [readString(body, 'stockMovementId')],
    },
  };
}

const NOUN = 'yêu cầu sản xuất';
const DELIVERY_NOUN = 'phiếu giao';

const requestSpec = (
  action: ChangeAction,
  verb: string,
  also: readonly ChangeResource[] = [],
): ChangeSpec => ({
  action,
  subject: ChangeResource.PRODUCTION_REQUESTS,
  also,
  extract: productionRequestTarget,
  summary: ({ actor, code }) =>
    `${actor} vừa ${verb.replace('{c}', named(NOUN, code))}`,
});

export const ProductionChanges = {
  created: requestSpec(ChangeAction.PRODUCTION_REQUEST_CREATED, 'tạo {c}'),
  edited: requestSpec(ChangeAction.PRODUCTION_REQUEST_EDITED, 'sửa {c}'),
  itemAdded: requestSpec(
    ChangeAction.PRODUCTION_REQUEST_ITEM_ADDED,
    'thêm hàng vào {c}',
  ),
  statusChanged: requestSpec(
    ChangeAction.PRODUCTION_REQUEST_STATUS_CHANGED,
    'cập nhật trạng thái {c}',
  ),
  // DELETE trả `{ success: true }`: không có mã, id lấy từ `:id`.
  deleted: requestSpec(
    ChangeAction.PRODUCTION_REQUEST_DELETED,
    'xoá một yêu cầu sản xuất',
  ),
  received: requestSpec(ChangeAction.PRODUCTION_RECEIVED, 'nhận hàng của {c}', [
    ChangeResource.INVENTORIES,
    ChangeResource.STOCK_MOVEMENTS,
  ]),
  // Phía xưởng
  accepted: requestSpec(
    ChangeAction.PRODUCTION_REQUEST_ACCEPTED,
    'nhận làm {c}',
  ),
  declined: requestSpec(
    ChangeAction.PRODUCTION_REQUEST_DECLINED,
    'từ chối {c}',
  ),
  deliveryCreated: requestSpec(
    ChangeAction.PRODUCTION_DELIVERY_CREATED,
    'tạo phiếu giao hàng cho {c}',
    [ChangeResource.PRODUCTION_DELIVERIES],
  ),
  deliveryCancelled: {
    action: ChangeAction.PRODUCTION_DELIVERY_CANCELLED,
    subject: ChangeResource.PRODUCTION_DELIVERIES,
    also: [ChangeResource.PRODUCTION_REQUESTS],
    extract: deliveryTarget,
    summary: ({ actor, code }) =>
      `${actor} vừa huỷ ${named(DELIVERY_NOUN, code)}`,
  },
  deliveryReceived: {
    action: ChangeAction.PRODUCTION_DELIVERY_RECEIVED,
    subject: ChangeResource.PRODUCTION_DELIVERIES,
    also: [
      ChangeResource.PRODUCTION_REQUESTS,
      ChangeResource.INVENTORIES,
      ChangeResource.STOCK_MOVEMENTS,
    ],
    extract: deliveryReceiveTarget,
    summary: ({ actor, code }) =>
      `${actor} vừa nhận hàng xưởng giao cho ${named(NOUN, code)}`,
  },
  deliveryRejected: {
    action: ChangeAction.PRODUCTION_DELIVERY_REJECTED,
    subject: ChangeResource.PRODUCTION_DELIVERIES,
    also: [ChangeResource.PRODUCTION_REQUESTS],
    extract: deliveryTarget,
    summary: ({ actor, code }) =>
      `${actor} vừa từ chối ${named(DELIVERY_NOUN, code)}`,
  },
} satisfies Record<string, ChangeSpec>;
