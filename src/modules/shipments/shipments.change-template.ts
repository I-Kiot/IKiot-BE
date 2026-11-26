import {
  ChangeAction,
  ChangeResource,
} from '../../common/constants/change-feed';
import type {
  ChangeExtractContext,
  ChangeSpec,
  ChangeTarget,
} from '../../common/realtime/change-feed.types';
import { named, readRef, readRefOf } from '../../common/realtime/change-ref';

/** Nội dung feed `entity:changed` của giao hàng. */

/** Lấy shipment và đơn từ body. */
export function shipmentTarget({
  body,
  params,
}: ChangeExtractContext): ChangeTarget {
  const shipment = readRef(body);
  const order = readRefOf(body, 'order');
  return {
    subjectId: params.id ?? shipment?.id ?? null,
    code: order?.code ?? null,
    related: { [ChangeResource.ORDERS]: [order?.id] },
  };
}

const shipmentSpec = (
  action: ChangeAction,
  verb: string,
  quiet = false,
): ChangeSpec => ({
  action,
  subject: ChangeResource.SHIPMENTS,
  also: [ChangeResource.ORDERS],
  quiet,
  extract: shipmentTarget,
  summary: ({ actor, code }) =>
    `${actor} vừa ${verb.replace('{c}', named('đơn', code))}`,
});

export const ShipmentChanges = {
  created: shipmentSpec(
    ChangeAction.SHIPMENT_CREATED,
    'bàn giao {c} cho vận chuyển',
  ),
  pickedUp: shipmentSpec(
    ChangeAction.SHIPMENT_PICKED_UP,
    'nhận hàng {c} để đi giao',
  ),
  eventAdded: shipmentSpec(
    ChangeAction.SHIPMENT_EVENT_ADDED,
    'cập nhật hành trình giao {c}',
  ),
  delivered: shipmentSpec(
    ChangeAction.SHIPMENT_DELIVERED,
    'giao thành công {c}',
  ),
  cashCollected: shipmentSpec(
    ChangeAction.SHIPMENT_CASH_COLLECTED,
    'thu tiền mặt {c}',
  ),
  qrReissued: shipmentSpec(
    ChangeAction.SHIPMENT_QR_REISSUED,
    'tạo lại mã QR cho {c}',
    true,
  ),
  failed: shipmentSpec(
    ChangeAction.SHIPMENT_FAILED,
    'báo giao không thành {c}',
  ),
  driverChanged: shipmentSpec(
    ChangeAction.SHIPMENT_DRIVER_CHANGED,
    'đổi shipper của {c}',
  ),
} satisfies Record<string, ChangeSpec>;
