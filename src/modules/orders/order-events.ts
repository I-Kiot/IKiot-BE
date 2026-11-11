import type { Prisma } from '../../../generated/prisma/client';
import {
  OrderEventRefType,
  OrderEventSource,
  type OrderEventType,
} from '../../common/constants/order-event-type';
import { SystemRole } from '../../common/constants/system-role';
import type { AuthUser } from '../../common/types/auth-user.type';
import { USER_REF_SELECT } from './order-read';
import { toUserRef } from './order-read.mapper';

/**
 * Nhật ký thao tác trên đơn (`order_events`). Hàm thường, không DI (cùng kiểu `order-cash-flow.ts`): mọi chỗ ghi truyền `tx` của chính transaction đang đổi đơn,
 * và chỉ gọi sau khi lệnh chiếm trạng thái (`updateMany ... count === 1`) đã thành công, nên sự kiện chỉ tồn tại khi thay đổi tồn tại; lỗi về sau trong transaction cuốn cả sự kiện đi.
 */

export type OrderEventActor =
  | { source: typeof OrderEventSource.USER; userId: string }
  | { source: typeof OrderEventSource.WEBHOOK }
  | { source: typeof OrderEventSource.SYSTEM };

export const userActor = (user: AuthUser): OrderEventActor => ({
  source: OrderEventSource.USER,
  userId: user.userId,
});

/** Webhook SePay: không có người dùng, hệ thống ngoài báo tiền về. */
export const WEBHOOK_ACTOR: OrderEventActor = {
  source: OrderEventSource.WEBHOOK,
};

/** Tác vụ nền (cron QR hết hạn): không có người dùng, `actor_id` để trống. */
export const SYSTEM_ACTOR: OrderEventActor = {
  source: OrderEventSource.SYSTEM,
};

export type OrderEventScalar = string | number | boolean | null;

export type OrderEventChanges = Record<
  string,
  { from: OrderEventScalar; to: OrderEventScalar }
>;

export type OrderEventLineRef = {
  name: string;
  sku: string;
  quantity: number;
};

export type OrderEventLineChange = {
  name: string;
  sku: string;
  quantity?: { from: number; to: number };
  unitPrice?: { from: number; to: number };
};

/** Là `type` chứ không phải `interface` để gán thẳng được vào `Prisma.InputJsonValue`. */
export type OrderEventMetadata = {
  refType?: OrderEventRefType;
  refId?: string;
  refCode?: string | null;
  amount?: number;
  method?: string;
  paymentId?: string;
  paymentReference?: string | null;
  sepayTransactionId?: string | null;
  refundAmount?: number;
  refundMethod?: string | null;
  reason?: string | null;
  note?: string | null;
  receiverName?: string | null;
  fulfillmentId?: string;
  packageCount?: number;
  carrierType?: string;
  carrierName?: string | null;
  trackingCode?: string | null;
  fromId?: string | null;
  toId?: string | null;
  itemId?: string;
  sku?: string;
  productName?: string;
  firstTime?: boolean;
  deliveryCode?: string | null;
  quantity?: number;
  grandTotal?: number;
  fulfillmentType?: string;
  paymentMethod?: string | null;
  good?: number;
  damaged?: number;
  orderSettled?: boolean;
  /** QR_PAID: tiền về sau khi mã QR đã hết hạn nhưng vẫn chốt được. */
  lateAfterExpiry?: boolean;
  /** QR_PAID: khách chuyển thiếu so với mã QR, khoản được ghi là trả một phần. */
  partial?: boolean;
  /** QR_PAID: số mã QR đã yêu cầu (khi khác số thực nhận). */
  requested?: number;
  /** QR_PAID / PAID_OFFLINE: số còn phải thu của đơn sau khoản này. */
  due?: number;
  /** QR_PAID: khách trả dư so với đơn sau khoản này. */
  overpaidBy?: number;
  /** PAID_OFFLINE: tiền thối. */
  change?: number;
  returnId?: string;
  returnCode?: string | null;
  shipmentId?: string | null;
  lines?: {
    added: OrderEventLineRef[];
    removed: OrderEventLineRef[];
    changed: OrderEventLineChange[];
  };
};

/** Liên kết tới một lần giao. Shipment không có mã riêng nên `refCode` là mã vận đơn (nếu có). */
export function shipmentRef(
  shipmentId: string,
  trackingCode: string | null | undefined,
): OrderEventMetadata {
  return {
    refType: OrderEventRefType.SHIPMENT,
    refId: shipmentId,
    refCode: trackingCode ?? null,
  };
}

/** Liên kết tới phiếu hoàn của đơn. */
export function returnRef(orderReturn: {
  id: string;
  code: string;
}): OrderEventMetadata {
  return {
    refType: OrderEventRefType.ORDER_RETURN,
    refId: orderReturn.id,
    refCode: orderReturn.code,
  };
}

export type OrderEventInput = {
  tenantId: string;
  orderId: string;
  type: OrderEventType;
  fromStatus?: string | null;
  toStatus?: string | null;
  changes?: OrderEventChanges;
  metadata?: OrderEventMetadata;
};

const ACTOR_SELECT = {
  id: true,
  phoneNumber: true,
  profileFirstName: true,
  profileLastName: true,
  systemRole: true,
  role: { select: { name: true } },
} as const satisfies Prisma.UserSelect;

type ActorRow = Prisma.UserGetPayload<{ select: typeof ACTOR_SELECT }>;

/** Tên, vai trò chụp lúc ghi. STAFF lấy tên `Role`; ADMIN / TENANT_OWNER không có dòng `Role` nên lấy mã `systemRole`. Không có người dùng thì để trống hết. */
export function actorSnapshot(row: ActorRow | null): {
  actorId: string | null;
  actorName: string | null;
  actorRole: string | null;
} {
  if (!row) return { actorId: null, actorName: null, actorRole: null };
  return {
    actorId: row.id,
    actorName: toUserRef(row)?.name ?? null,
    actorRole:
      row.systemRole === SystemRole.STAFF
        ? (row.role?.name ?? null)
        : row.systemRole,
  };
}

/** Ghi từng sự kiện một (không `createMany`) để `occurred_at = clock_timestamp()` tăng dần và giữ đúng thứ tự trong cùng transaction. */
export async function recordOrderEvents(
  tx: Prisma.TransactionClient,
  actor: OrderEventActor,
  events: readonly OrderEventInput[],
): Promise<void> {
  if (events.length === 0) return;
  const snapshot =
    actor.source === OrderEventSource.USER
      ? actorSnapshot(
          await tx.user.findUnique({
            where: { id: actor.userId },
            select: ACTOR_SELECT,
          }),
        )
      : { actorId: null, actorName: null, actorRole: null };
  for (const event of events) {
    await tx.orderEvent.create({
      data: {
        tenantId: event.tenantId,
        orderId: event.orderId,
        type: event.type,
        fromStatus: event.fromStatus ?? null,
        toStatus: event.toStatus ?? null,
        source: actor.source,
        ...snapshot,
        changes: event.changes,
        metadata: event.metadata,
      },
    });
  }
}

export function recordOrderEvent(
  tx: Prisma.TransactionClient,
  actor: OrderEventActor,
  event: OrderEventInput,
): Promise<void> {
  return recordOrderEvents(tx, actor, [event]);
}

type Decimalish = { toNumber(): number };
/** Giá trị một trường của đơn trước khi đổi về dạng hiển thị: số tiền là Decimal, ngày hẹn là Date. */
export type OrderFieldValue = OrderEventScalar | Decimalish | Date | undefined;
type Comparable = OrderFieldValue;

/** Đổi giá trị về dạng hiển thị được: Decimal thành số, chuỗi rỗng thành null, Date thành `YYYY-MM-DD`. */
function normalize(value: Comparable): OrderEventScalar {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') return value.toNumber();
  if (typeof value === 'string') return value.trim() === '' ? null : value;
  return value;
}

/** Chỉ xét các khoá có mặt trong `after` (PATCH chỉ gửi trường cần đổi); trường không đổi bị bỏ. */
export function diffOrderFields<T extends Record<string, Comparable>>(
  before: T,
  after: Partial<T>,
  fields: readonly (keyof T & string)[],
): OrderEventChanges {
  const changes: OrderEventChanges = {};
  for (const field of fields) {
    if (after[field] === undefined) continue;
    const from = normalize(before[field]);
    const to = normalize(after[field]);
    if (from !== to) changes[field] = { from, to };
  }
  return changes;
}

export type LineSnap = {
  id?: string;
  name: string;
  sku: string;
  quantity: number;
  unitPrice: number;
  /** Dòng con của combo (có cha) bị bỏ qua: chúng co giãn theo combo cha nên không phải thay đổi riêng. */
  parentItemId?: string | null;
};

/** Chỉ dòng cấp trên cùng (`parentItemId` rỗng): dòng cũ mất id là bị bỏ, dòng mới không có id là thêm, đổi số lượng hay đơn giá là đổi. */
export function diffOrderLines(
  allBefore: readonly (LineSnap & { id: string })[],
  allAfter: readonly LineSnap[],
): {
  added: OrderEventLineRef[];
  removed: OrderEventLineRef[];
  changed: OrderEventLineChange[];
} {
  const ref = (l: LineSnap): OrderEventLineRef => ({
    name: l.name,
    sku: l.sku,
    quantity: l.quantity,
  });
  const before = allBefore.filter((l) => !l.parentItemId);
  const after = allAfter.filter((l) => !l.parentItemId);
  const beforeById = new Map(before.map((l) => [l.id, l]));
  const keptIds = new Set(after.flatMap((l) => (l.id ? [l.id] : [])));
  const added: OrderEventLineRef[] = [];
  const changed: OrderEventLineChange[] = [];
  for (const line of after) {
    const old = line.id ? beforeById.get(line.id) : undefined;
    if (!old) {
      added.push(ref(line));
      continue;
    }
    const change: OrderEventLineChange = { name: line.name, sku: line.sku };
    if (old.quantity !== line.quantity)
      change.quantity = { from: old.quantity, to: line.quantity };
    if (old.unitPrice !== line.unitPrice)
      change.unitPrice = { from: old.unitPrice, to: line.unitPrice };
    if (change.quantity || change.unitPrice) changed.push(change);
  }
  const removed = before.filter((l) => !keptIds.has(l.id)).map(ref);
  return { added, removed, changed };
}

/** Tên hiển thị (`lastName firstName`, thiếu thì số điện thoại) của một tập người dùng, một lần truy vấn. */
export async function displayNamesOf(
  tx: Prisma.TransactionClient,
  ids: readonly (string | null | undefined)[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => !!id))];
  if (unique.length === 0) return new Map();
  const rows = await tx.user.findMany({
    where: { id: { in: unique } },
    ...USER_REF_SELECT,
  });
  return new Map(rows.map((row) => [row.id, toUserRef(row)?.name ?? row.id]));
}
