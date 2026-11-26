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
  upperFirst,
} from '../../common/realtime/change-ref';

/** Nội dung feed `entity:changed` của đơn hàng. */

/** Lấy mã đơn từ các dạng body khác nhau của route đơn. */
export function orderTarget({
  body,
  params,
}: ChangeExtractContext): ChangeTarget {
  const ref = readRefOf(body, 'order') ?? readRef(body);
  return { subjectId: params.id ?? ref?.id ?? null, code: ref?.code ?? null };
}

/** `ship` trả chi tiết shipment: chủ thể vẫn là đơn (`:id`), kèm id shipment. */
export function shipTarget(ctx: ChangeExtractContext): ChangeTarget {
  const target = orderTarget(ctx);
  const shipment = readRef(ctx.body);
  return {
    ...target,
    related: { [ChangeResource.SHIPMENTS]: [shipment?.id] },
  };
}

/** `pack` trả Fulfillment (có `orderId`, không có mã đơn) nên phải tra mã đơn một lần. */
export async function packTarget({
  body,
  params,
  tenantId,
  prisma,
}: ChangeExtractContext): Promise<ChangeTarget> {
  const order = params.id
    ? await prisma.order.findFirst({
        where: { id: params.id, tenantId },
        select: { code: true },
      })
    : null;
  return {
    subjectId: params.id ?? null,
    code: order?.code ?? null,
    related: { [ChangeResource.FULFILLMENTS]: [readRef(body)?.id] },
  };
}

const orderSpec = (
  action: ChangeAction,
  verb: string,
  also: readonly ChangeResource[] = [],
  extract: ChangeSpec['extract'] = orderTarget,
): ChangeSpec => ({
  action,
  subject: ChangeResource.ORDERS,
  also,
  extract,
  summary: ({ actor, code }) =>
    `${actor} vừa ${verb.replace('{c}', named('đơn', code))}`,
});

const STOCK = [ChangeResource.INVENTORIES] as const;

export const OrderChanges = {
  created: orderSpec(ChangeAction.ORDER_CREATED, 'tạo {c}', STOCK),
  posCreated: orderSpec(
    ChangeAction.ORDER_POS_CREATED,
    'bán {c} tại quầy',
    STOCK,
  ),
  cancelled: orderSpec(ChangeAction.ORDER_CANCELLED, 'huỷ {c}', STOCK),
  edited: orderSpec(ChangeAction.ORDER_EDITED, 'sửa {c}', STOCK),
  assigneeChanged: orderSpec(
    ChangeAction.ORDER_ASSIGNEE_CHANGED,
    'đổi người phụ trách {c}',
  ),
  priorityChanged: orderSpec(
    ChangeAction.ORDER_PRIORITY_CHANGED,
    'đổi mức ưu tiên {c}',
  ),
  customized: orderSpec(
    ChangeAction.ORDER_CUSTOMIZED,
    'cập nhật yêu cầu làm riêng của {c}',
  ),
  remittanceConfirmed: orderSpec(
    ChangeAction.ORDER_REMITTANCE_CONFIRMED,
    'xác nhận nhận tiền shipper nộp của {c}',
  ),
  statusChanged: orderSpec(
    ChangeAction.ORDER_STATUS_CHANGED,
    'cập nhật trạng thái {c}',
    STOCK,
  ),
  packed: orderSpec(
    ChangeAction.ORDER_PACKED,
    'đóng gói {c}',
    [ChangeResource.FULFILLMENTS, ChangeResource.INVENTORIES],
    packTarget,
  ),
  shipped: orderSpec(
    ChangeAction.ORDER_SHIPPED,
    'cho {c} bắt đầu vận chuyển',
    [ChangeResource.SHIPMENTS, ChangeResource.INVENTORIES],
    shipTarget,
  ),
  pickupCollected: orderSpec(
    ChangeAction.ORDER_PICKUP_COLLECTED,
    'thu tiền {c} khách tới lấy',
  ),
  pickupHandedOver: orderSpec(
    ChangeAction.ORDER_PICKUP_HANDED_OVER,
    'giao {c} cho khách tại cửa hàng',
    STOCK,
  ),
  heldSettled: orderSpec(
    ChangeAction.ORDER_HELD_SETTLED,
    'xử lý tiền giữ lại của {c}',
  ),
  excessRefunded: orderSpec(
    ChangeAction.ORDER_EXCESS_REFUNDED,
    'hoàn tiền thừa cho {c}',
  ),
  paidOffline: orderSpec(ChangeAction.ORDER_PAID_OFFLINE, 'thu tiền {c}'),

  // Phát tường minh (webhook SePay, cron hết hạn QR), không đi qua @EmitsChange.
  qrPaid: {
    action: ChangeAction.ORDER_QR_PAID,
    subject: ChangeResource.ORDERS,
    summary: ({ code }) =>
      `${upperFirst(named('đơn', code))} vừa được khách thanh toán qua SePay`,
  },
  qrPartiallyPaid: {
    action: ChangeAction.ORDER_QR_PARTIALLY_PAID,
    subject: ChangeResource.ORDERS,
    summary: ({ code }) =>
      `${upperFirst(named('đơn', code))} vừa nhận chuyển khoản một phần qua SePay`,
  },
  qrExpiredCancelled: {
    action: ChangeAction.ORDER_QR_EXPIRED_CANCELLED,
    subject: ChangeResource.ORDERS,
    also: STOCK,
    summary: ({ code }) =>
      `${upperFirst(named('đơn', code))} đã tự huỷ vì mã QR hết hạn`,
  },
  paymentQrExpired: {
    action: ChangeAction.PAYMENT_QR_EXPIRED,
    subject: ChangeResource.ORDERS,
    quiet: true,
    summary: () => 'Mã QR thanh toán đã hết hạn',
  },
} satisfies Record<string, ChangeSpec>;
