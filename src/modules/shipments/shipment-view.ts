import type { Prisma } from '../../../generated/prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import {
  PaymentKind,
  PaymentMethod,
  PaymentRecordStatus,
} from '../../common/constants/payment-method';
import { withNestedProfile } from '../../common/utils/user-profile';
import { buildSepayQrUrl } from '../orders/tenant-banking';
import { businessDayRange } from '../cash-drawer-sessions/business-date';
import { VIETNAM_TIMEZONE } from '../../common/constants/timezone';

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

/** Số shipper thu khi giao = tổng đơn − tiền cọc (schema: tính chứ không lưu). */
export function amountDueOf(order: {
  grandTotal: unknown;
  depositAmount: unknown;
}): number {
  return Number(order.grandTotal) - Number(order.depositAmount ?? 0);
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
      amountDue: amountDueOf(order),
    },
    driver: driver ? withNestedProfile(driver) : null,
  };
}

/** Khoản thu QR lúc giao của đơn, để shipper mở lại mã QR. `qrUrl` chỉ có khi khoản còn chờ tiền về. */
export interface ShipmentQrPayment {
  reference: string;
  amount: number;
  status: string;
  qrUrl: string | null;
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
    select: { paymentReference: true, amount: true, status: true },
  });

  let payment: ShipmentQrPayment | null = null;
  if (qrPayment?.paymentReference) {
    let qrUrl: string | null = null;
    if (qrPayment.status === PaymentRecordStatus.PENDING) {
      const banking = await prisma.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: {
          bankingBankName: true,
          bankingAccountNumber: true,
          bankingAccountName: true,
        },
      });
      qrUrl = buildSepayQrUrl(
        banking,
        Number(qrPayment.amount),
        qrPayment.paymentReference,
      );
    }
    payment = {
      reference: qrPayment.paymentReference,
      amount: Number(qrPayment.amount),
      status: qrPayment.status,
      qrUrl,
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
