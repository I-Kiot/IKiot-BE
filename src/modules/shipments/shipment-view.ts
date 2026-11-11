import type { Prisma } from '../../../generated/prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import {
  PaymentKind,
  PaymentMethod,
  PaymentRecordStatus,
} from '../../common/constants/payment-method';
import { withNestedProfile } from '../../common/utils/user-profile';
import { effectiveQrStatus, sepayQrView } from '../orders/sepay-qr';
import { businessDayRange } from '../cash-drawer-sessions/business-date';
import { VIETNAM_TIMEZONE } from '../../common/constants/timezone';
import { type MoneyLike } from '../../common/utils/money';
import { derivePaymentStatus, paymentRowsOf } from '../orders/payment-status';

// Hình dạng `Shipment` của contract §4, dùng chung cho ShipmentService và ShipmentDeliveryService
// để hai nơi không thể trả về hai hình dạng khác nhau.

/** Một người trong payload: `{ id, phoneNumber, profile }` như mọi chỗ khác (`withNestedProfile`). */
export const PERSON_SELECT = {
  id: true,
  phoneNumber: true,
  profileFirstName: true,
  profileLastName: true,
  profileAvatarUrl: true,
} as const;

export const SHIPMENT_SUMMARY_INCLUDE = {
  order: {
    select: {
      id: true,
      code: true,
      status: true,
      grandTotal: true,
      depositAmount: true,
      payments: { select: { kind: true, status: true, amount: true } },
      customer: { select: { name: true } },
    },
  },
  driver: { select: PERSON_SELECT },
} as const satisfies Prisma.ShipmentInclude;

const SHIPMENT_DETAIL_INCLUDE = {
  ...SHIPMENT_SUMMARY_INCLUDE,
  events: {
    orderBy: { occurredAt: 'asc' },
    include: { createdBy: { select: PERSON_SELECT } },
  },
} as const satisfies Prisma.ShipmentInclude;

type ShipmentSummaryRow = Prisma.ShipmentGetPayload<{
  include: typeof SHIPMENT_SUMMARY_INCLUDE;
}>;

/**
 * Số còn phải thu của đơn tại thời điểm xem: lớp mỏng trên `derivePaymentStatus(...).due` (một quy tắc cho mọi nơi tính số còn thu): tổng đơn trừ mọi khoản đã thu (cọc, thu khi giao, trả đủ), trừ tiền đã trả lại khách. Khoản đang chờ chưa tính; không âm.
 * Đơn cũ có `depositAmount` nhưng không có dòng Payment cọc vẫn tính cọc theo `depositAmount` (dữ liệu trước khi cọc có Payment).
 * Trước đây số shipper thu lúc giao là `grandTotal − depositAmount` (không trừ khoản đã thu thật), nên một khoản QR về trước khi giao làm shipper thu lần hai.
 */
export function amountStillDueOf(order: {
  grandTotal: unknown;
  depositAmount: unknown;
  payments: readonly { kind: string; status: string; amount: unknown }[];
}): number {
  return derivePaymentStatus(
    order.grandTotal as MoneyLike,
    paymentRowsOf({
      depositAmount: order.depositAmount as MoneyLike,
      payments: order.payments as {
        kind: string;
        status: string;
        amount: MoneyLike;
      }[],
    }),
  ).due;
}

export function toSummary(row: ShipmentSummaryRow) {
  const { order, driver, ...rest } = row;
  return {
    ...rest,
    shippingCost: rest.shippingCost === null ? null : Number(rest.shippingCost),
    order: {
      id: order.id,
      code: order.code,
      status: order.status,
      customerName: order.customer.name,
      amountDue: amountStillDueOf(order),
    },
    driver: driver ? withNestedProfile(driver) : null,
  };
}

/**
 * Khoản thu QR lúc giao của đơn, để shipper mở lại mã QR. `qrUrl` chỉ có khi khoản còn chờ tiền về VÀ chưa hết hạn: hết hạn thì `qrUrl` null, `status` là EXPIRED và `expired` true (kể cả khi cron chưa kịp đổi trạng thái).
 */
export interface ShipmentQrPayment {
  reference: string;
  amount: number;
  status: 'PENDING' | 'PAID' | 'FAILED' | 'CANCELLED' | 'EXPIRED';
  qrUrl: string | null;
  expiresAt: string;
  expired: boolean;
}

/**
 * Chi tiết một lần giao: thông tin, nhật trình, khoản thu QR (nếu có). Mã QR dựng lại từ tài khoản ngân hàng
 * hiện tại của shop, nên mở lại sau khi đóng màn vẫn đúng mã.
 */
export async function loadShipmentDetail(
  prisma: Pick<PrismaService, 'shipment' | 'payment' | 'tenant'>,
  tenantId: string,
  id: string,
) {
  const { events, ...row } = await prisma.shipment.findFirstOrThrow({
    where: { id, tenantId },
    include: SHIPMENT_DETAIL_INCLUDE,
  });

  const qrPayment = await prisma.payment.findFirst({
    where: {
      tenantId,
      orderId: row.orderId,
      kind: PaymentKind.BALANCE,
      method: PaymentMethod.SEPAY,
    },
    orderBy: { createdAt: 'desc' },
    select: {
      paymentReference: true,
      amount: true,
      status: true,
      expiresAt: true,
      createdAt: true,
    },
  });

  let payment: ShipmentQrPayment | null = null;
  if (qrPayment?.paymentReference) {
    const now = new Date();
    // Hiển thị PENDING đã quá hạn là EXPIRED, không chờ cron.
    const status = effectiveQrStatus(qrPayment, now);
    // Chỉ đọc tài khoản ngân hàng khi còn dựng được mã (khoản còn chờ và chưa hết hạn).
    const banking =
      status === PaymentRecordStatus.PENDING
        ? await prisma.tenant.findUniqueOrThrow({
            where: { id: tenantId },
            select: {
              bankingBankName: true,
              bankingAccountNumber: true,
              bankingAccountName: true,
            },
          })
        : null;
    const view = sepayQrView(
      banking,
      {
        amount: Number(qrPayment.amount),
        reference: qrPayment.paymentReference,
        expiresAt: qrPayment.expiresAt,
        createdAt: qrPayment.createdAt,
      },
      'read',
      now,
    );
    payment = {
      reference: qrPayment.paymentReference,
      amount: Number(qrPayment.amount),
      status: status as ShipmentQrPayment['status'],
      qrUrl: view.qrUrl,
      expiresAt: view.expiresAt.toISOString(),
      expired: view.expired,
    };
  }

  return {
    ...toSummary(row),
    events: events.map(({ createdBy, ...event }) => ({
      ...event,
      createdBy: createdBy ? withNestedProfile(createdBy) : null,
    })),
    payment,
  };
}

/**
 * `from` / `to` (YYYY-MM-DD) là khoảng nửa mở theo giờ Việt Nam, tính trọn ngày: dòng ghi 23:30 vẫn thuộc đúng ngày, không bị đẩy sang hôm sau. Dùng chung cho danh sách và lịch sử shipper để hai nơi không lệch điểm kết thúc ngày.
 */
export function localDayWindow(
  from: string | undefined,
  to: string | undefined,
): { gte?: Date; lt?: Date } | undefined {
  if (!from && !to) return undefined;
  const day = (value: string) =>
    businessDayRange(new Date(`${value}T00:00:00Z`), VIETNAM_TIMEZONE);
  return {
    ...(from ? { gte: day(from).start } : {}),
    ...(to ? { lt: day(to).end } : {}),
  };
}

export function shipmentSearchWhere(search: string): Prisma.ShipmentWhereInput {
  const contains = { contains: search, mode: 'insensitive' as const };
  return {
    OR: [
      { order: { code: contains } },
      { trackingCode: contains },
      { recipientName: contains },
      { recipientPhone: contains },
    ],
  };
}
