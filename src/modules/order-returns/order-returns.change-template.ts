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
  readRef,
  readRefOf,
  readString,
} from '../../common/realtime/change-ref';

/** Nội dung feed `entity:changed` của đơn hoàn hàng. Chỉ tên người làm + động từ + mã đơn hoàn. */

/** Lấy id đơn hoàn từ body. */
export function returnTarget({
  body,
  params,
}: ChangeExtractContext): ChangeTarget {
  const ref = readRef(body);
  return {
    subjectId: params.id ?? ref?.id ?? null,
    code: ref?.code ?? null,
    related: {
      [ChangeResource.ORDERS]: [
        readRefOf(body, 'order')?.id,
        readRefOf(body, 'replacementOrder')?.id,
      ],
      [ChangeResource.SHIPMENTS]: [readString(body, 'shipmentId')],
    },
  };
}

const NOUN = 'đơn hoàn';

const returnSpec = (
  action: ChangeAction,
  summary: (actor: string, c: string) => string,
  also: readonly ChangeResource[] = [],
): ChangeSpec => ({
  action,
  subject: ChangeResource.ORDER_RETURNS,
  also: [ChangeResource.ORDERS, ...also],
  extract: returnTarget,
  summary: ({ actor, code }) => summary(actor, named(NOUN, code)),
});

const STOCK = [ChangeResource.INVENTORIES] as const;

export const OrderReturnChanges = {
  created: returnSpec(
    ChangeAction.RETURN_CREATED,
    (a, c) => `${a} vừa tạo ${c}`,
  ),
  failedDeliveryConfirmed: returnSpec(
    ChangeAction.RETURN_FAILED_DELIVERY_CONFIRMED,
    (a, c) => `${a} vừa xác nhận hàng giao không thành đã về (${c})`,
    [ChangeResource.SHIPMENTS, ...STOCK],
  ),
  received: returnSpec(
    ChangeAction.RETURN_RECEIVED,
    (a, c) => `${a} vừa ghi nhận hàng hoàn của ${c} đã về`,
  ),
  inspected: returnSpec(
    ChangeAction.RETURN_INSPECTED,
    (a, c) => `${a} vừa kiểm xong ${c}`,
    STOCK,
  ),
  cancelled: returnSpec(
    ChangeAction.RETURN_CANCELLED,
    (a, c) => `${a} vừa huỷ ${c}`,
  ),
  replacementLinked: returnSpec(
    ChangeAction.RETURN_REPLACEMENT_LINKED,
    (a, c) => `${a} vừa gắn đơn mua lại cho ${c}`,
  ),
} satisfies Record<string, ChangeSpec>;
