import { createHash, randomUUID } from 'crypto';
import { ConflictException, type Logger } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client';
import {
  FulfillmentType,
  OrderPaymentStatus,
  OrderStatus,
} from '../../common/constants/order-status';
import {
  OPEN_QR_PAYMENT_STATUSES,
  PaymentMethod,
  PaymentRecordStatus,
  SepayRejectReason,
  SepayTransactionOutcome,
} from '../../common/constants/payment-method';
import { ErrorCode } from '../../common/errors/error-codes';
import type { PrismaService } from '../../prisma/prisma.service';
import type { NotificationService } from '../notifications/notifications.service';
import { OrderNotificationTemplates } from '../notifications/templates/order.templates';
import { CashFlowCategory } from '../../common/constants/cash-flow-category';
import { writeUnallocatedCashFlow } from './order-cash-flow';
import { buildSepayQrUrl, type TenantBanking } from './tenant-banking';

// Hạn mã QR SePay. Hàm thường, không DI (cùng kiểu `tenant-banking.ts`): bán quầy, thu tiền khi giao, thu tại quầy, cron và webhook đều dùng chung.
// Quy tắc cứng: mọi chỗ phát mã QR đi qua `sepayQrView` - đó là cửa duy nhất tới hàm dựng link VietQR (có spec quét source giữ điều này), và webhook luôn tính hết hạn trước khi quyết định.

/**
 * Mã QR sống 15 phút kể từ lúc phát. Là hằng số chứ không phải env: đếm ngược ở FE, cron và e2e phải cùng một con số, cấu hình lệch giữa các môi trường chỉ sinh ra mã "còn hạn" ở màn hình nhưng đã bị cron huỷ.
 */
export const SEPAY_QR_TTL_MINUTES = 15;
const TTL_MS = SEPAY_QR_TTL_MINUTES * 60_000;

/** Đồng hồ của một mã QR. Khoản cũ chưa có cột hạn thì tính từ lúc tạo (`createdAt`). */
export interface QrClock {
  expiresAt?: Date | null;
  createdAt: Date;
}

/** Hạn của một mã mới phát lúc `now`. Cách DUY NHẤT để một `Payment` có `expiresAt`. */
export function newQrExpiresAt(now: Date): Date {
  return new Date(now.getTime() + TTL_MS);
}

/** Khoản cũ chưa có `expiresAt` thì tính từ lúc tạo. */
export function qrExpiresAt(qr: QrClock): Date {
  return qr.expiresAt ?? new Date(qr.createdAt.getTime() + TTL_MS);
}

/** Đúng mốc hạn là đã hết (`>=`). */
export function isQrExpired(qr: QrClock, now: Date = new Date()): boolean {
  return now.getTime() >= qrExpiresAt(qr).getTime();
}

/** Mã phát trước mốc này thì (chắc chắn) đã hết hạn: để cron lọc sơ trên cột `createdAt` trước khi lọc chính xác bằng `isQrExpired`. */
export function qrIssuedBefore(now: Date): Date {
  return new Date(now.getTime() - TTL_MS);
}

/** Ném `QR_PAYMENT_EXPIRED` (409) nếu mã đã hết hạn. */
export function assertQrPayable(qr: QrClock, now: Date = new Date()): void {
  if (!isQrExpired(qr, now)) return;
  throw new ConflictException({
    code: ErrorCode.QR_PAYMENT_EXPIRED,
    message: 'The QR code has expired',
    errors: { expiresAt: qrExpiresAt(qr).toISOString() },
  });
}

export interface SepayQrView {
  qrUrl: string | null;
  expiresAt: Date;
  expired: boolean;
}

/**
 * CỬA DUY NHẤT tới hàm dựng link VietQR. `issue`: đang phát mã cho người dùng, hết hạn thì ném `QR_PAYMENT_EXPIRED` (không bao giờ đưa mã chết cho khách quét).
 * `read`: mở lại mã đã có, hết hạn thì `qrUrl` là null để màn hình hiện "đã hết hạn".
 */
export function sepayQrView(
  banking: TenantBanking | null,
  qr: QrClock & { amount: number; reference: string },
  mode: 'issue' | 'read',
  now: Date = new Date(),
): SepayQrView {
  const expiresAt = qrExpiresAt(qr);
  const expired = isQrExpired(qr, now);
  if (mode === 'issue') {
    assertQrPayable(qr, now);
    if (!banking) {
      throw new Error('Issuing a QR needs the shop banking details');
    }
  }
  if (expired || !banking) return { qrUrl: null, expiresAt, expired };
  return {
    qrUrl: buildSepayQrUrl(banking, qr.amount, qr.reference),
    expiresAt,
    expired,
  };
}

/** Trạng thái hiệu lực để hiển thị: PENDING mà đã quá hạn thì coi như EXPIRED, không chờ cron. */
export function effectiveQrStatus(
  payment: { status: string } & QrClock,
  now: Date = new Date(),
): string {
  return payment.status === PaymentRecordStatus.PENDING &&
    isQrExpired(payment, now)
    ? PaymentRecordStatus.EXPIRED
    : payment.status;
}

/**
 * Đơn có đang chờ chính khoản QR này không: khoản còn mở, và đơn đang ở bước chờ tiền: đơn quầy thì PENDING (chờ chuyển khoản), giao tận nơi thì RECEIVED (shipper đã giao, chờ chuyển khoản),
 * khách tới lấy thì PACKED mà chưa thu đủ.
 */
export function isAwaitingQrTransfer(
  payment: { status: string },
  order: { status: string; fulfillmentType: string; paymentStatus: string },
): boolean {
  if (!OPEN_QR_PAYMENT_STATUSES.includes(payment.status)) return false;
  if (order.fulfillmentType === FulfillmentType.TAKEAWAY) {
    return order.status === OrderStatus.PENDING;
  }
  if (order.fulfillmentType === FulfillmentType.STORE_PICKUP) {
    return (
      order.status === OrderStatus.PACKED &&
      order.paymentStatus !== OrderPaymentStatus.PAID
    );
  }
  return order.status === OrderStatus.RECEIVED;
}

export type SepayTransferDecision =
  | { action: 'SETTLE'; late: boolean; partial: boolean }
  | { action: 'REJECT'; reason: SepayRejectReason };

/**
 * Bảng quyết định của webhook: không còn chờ thì từ chối (dù hết hạn hay không); còn lại chốt. Chuyển thiếu so với số mã QR yêu cầu vẫn chốt, là khoản trả một phần (`partial`, đơn chưa đủ tiền nên chưa hoàn thành);
 * muộn (`late`) nếu mã đã hết hạn nhưng đơn vẫn chờ. Trước đây chuyển thiếu bị bỏ qua (đơn giao chỉ ghi log, đơn quầy ném lỗi) nên tiền đã về mà không có dấu vết nào.
 */
export function decideSepayTransfer(input: {
  expired: boolean;
  waiting: boolean;
  amountDue: number;
  transferAmount: number;
  rejectReason: SepayRejectReason;
}): SepayTransferDecision {
  if (!input.waiting) return { action: 'REJECT', reason: input.rejectReason };
  return {
    action: 'SETTLE',
    late: input.expired,
    partial: input.transferAmount < input.amountDue,
  };
}

/** Một lần SePay báo tiền về, đã chuẩn hoá từ payload webhook (hay từ tham số của hàm gọi trực tiếp trong test). */
export interface SepayTransfer {
  /** Mã giao dịch SePay; có thể không có. */
  sepayTransactionId: string | null;
  /** Khoá chống xử lý lặp: xem `sepayDedupeKey`. */
  dedupeKey: string;
  amount: number;
  accountNumber: string | null;
  content: string | null;
  bankReferenceCode: string | null;
  transactionDate: string | null;
}

type TransferPayload = {
  sepayTransactionId?: string | null;
  bankReferenceCode?: string | null;
  accountNumber?: string | null;
  transactionDate?: string | null;
  amount: number;
  content?: string | null;
};

/**
 * Khoá chống xử lý lặp của một giao dịch (hàm thuần): `id:<mã giao dịch>`; không có mã thì `ref:<referenceCode của ngân hàng>`; không có cả hai thì `h:` + sha256(tài khoản | thời điểm | số tiền | nội dung).
 * Nhờ vậy giao dịch không có mã vẫn vào sổ đúng một lần: SePay gọi lại cùng payload ra cùng khoá. Hệ quả chấp nhận được: hai giao dịch thật sự khác nhau nhưng giống hệt mọi trường (và đều không có mã) bị coi là một.
 */
export function sepayDedupeKey(payload: TransferPayload): string {
  if (payload.sepayTransactionId) return `id:${payload.sepayTransactionId}`;
  if (payload.bankReferenceCode) return `ref:${payload.bankReferenceCode}`;
  const hash = createHash('sha256')
    .update(
      [
        payload.accountNumber ?? '',
        payload.transactionDate ?? '',
        String(payload.amount),
        payload.content ?? '',
      ].join('|'),
    )
    .digest('hex');
  return `h:${hash}`;
}

/** Chuẩn hoá một giao dịch. Chuỗi rỗng thành null: `''` dễ bị người đối soát hiểu là "đã có mã". */
export function buildSepayTransfer(payload: TransferPayload): SepayTransfer {
  const text = (value: string | null | undefined) =>
    typeof value === 'string' && value.trim() !== '' ? value : null;
  const normalized = {
    sepayTransactionId: text(payload.sepayTransactionId),
    bankReferenceCode: text(payload.bankReferenceCode),
    accountNumber: text(payload.accountNumber),
    transactionDate: text(payload.transactionDate),
    content: text(payload.content),
    amount: payload.amount,
  };
  return { ...normalized, dedupeKey: sepayDedupeKey(normalized) };
}

/** Đọc payload webhook SePay (kiểu không rõ) thành một giao dịch chuẩn. `id` của SePay là số; trường sai kiểu coi như không có. */
export function sepayTransferFromPayload(
  payload: Record<string, unknown>,
): SepayTransfer {
  const str = (value: unknown) =>
    typeof value === 'string' || typeof value === 'number'
      ? String(value)
      : null;
  return buildSepayTransfer({
    sepayTransactionId: str(payload.id),
    bankReferenceCode: str(payload.referenceCode),
    accountNumber: str(payload.accountNumber),
    transactionDate: str(payload.transactionDate),
    content: typeof payload.content === 'string' ? payload.content : null,
    amount: Number(payload.transferAmount ?? 0),
  });
}

export interface SepayLedgerRow {
  /** Null = tiền về tài khoản không thuộc shop nào. */
  tenantId: string | null;
  transfer: SepayTransfer;
  /** Mã ORD trích từ nội dung; null khi không có mã. */
  paymentReference: string | null;
  outcome: SepayTransactionOutcome;
  rejectReason?: SepayRejectReason;
  orderId?: string | null;
  paymentId?: string | null;
}

/** Giao dịch này đã vào sổ của shop chưa (kiểm sớm, ngoài transaction; chốt chặn thật là unique index trong `claimSepayTransaction`). */
export async function sepayTransactionSeen(
  prisma: Pick<PrismaService, 'sepayTransaction'>,
  tenantId: string,
  transfer: Pick<SepayTransfer, 'dedupeKey'>,
): Promise<boolean> {
  const row = await prisma.sepayTransaction.findFirst({
    where: { tenantId, dedupeKey: transfer.dedupeKey },
    select: { id: true },
  });
  return row !== null;
}

/**
 * Ghi giao dịch vào sổ, trong transaction đang chốt tiền: trả id dòng sổ nếu đây là lần đầu thấy, `null` nếu đã có (webhook gọi lại, hoặc hai request đua nhau: request sau chờ khoá unique rồi nhận `null`).
 * `INSERT … ON CONFLICT DO NOTHING` không chỉ định đích nên bắt cả hai unique một phần (tenant + khoá, và tài khoản + khoá cho dòng không có tenant). Mọi giao dịch đều có khoá (`sepayDedupeKey`), nên không còn trường hợp "không có mã thì không ghi sổ".
 */
export async function claimSepayTransaction(
  tx: Prisma.TransactionClient,
  row: SepayLedgerRow,
): Promise<string | null> {
  const t = row.transfer;
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO sepay_transactions (
      id, tenant_id, sepay_transaction_id, dedupe_key, payment_reference, account_number, content,
      bank_reference_code, transaction_date, amount, outcome, reject_reason, order_id, payment_id
    ) VALUES (
      ${randomUUID()}, ${row.tenantId}, ${t.sepayTransactionId}, ${t.dedupeKey}, ${row.paymentReference},
      ${t.accountNumber}, ${t.content}, ${t.bankReferenceCode}, ${t.transactionDate}, ${t.amount}::numeric,
      ${row.outcome}, ${row.rejectReason ?? null}, ${row.orderId ?? null}, ${row.paymentId ?? null}
    )
    ON CONFLICT DO NOTHING
    RETURNING id`;
  return rows.length === 1 ? rows[0].id : null;
}

/** Lệnh chiếm trạng thái thua trong lúc đang chốt (đơn / khoản vừa đổi): ném trong transaction để cuốn cả dòng sổ, người gọi đọc lại rồi quyết định lại. */
export class SepayClaimLost extends Error {}

export const SEPAY_DUPLICATE_MESSAGE = 'Duplicate transaction';

type SepayNotifier = Pick<
  NotificationService,
  'notify' | 'tenantOwners' | 'notifySystem'
>;

/**
 * Tiền về mà không chốt được (đơn đã huỷ / đã thu, khoản đã bị thay): ghi sổ REJECTED, không đổi đơn, ghi sổ thu chi `UNALLOCATED_RECEIPT` (tiền thật đã nằm trong tài khoản; sổ phải khớp sao kê), rồi báo chủ shop để hoàn hoặc đối soát.
 * Dòng sổ SePay và dòng thu chi cùng một transaction. Dùng chung cho đơn quầy và thu khi giao / tại quầy (`sepay-settlement.ts`). Thông báo không bao giờ ném lỗi.
 */
export async function rejectLateSepayTransfer(
  prisma: Pick<PrismaService, '$transaction'>,
  notifications: SepayNotifier,
  logger: Pick<Logger, 'warn'>,
  input: {
    tenantId: string;
    transfer: SepayTransfer;
    paymentReference: string;
    reason: SepayRejectReason;
    order: { id: string; code: string };
    paymentId?: string | null;
    isPos: boolean;
  },
): Promise<{ message: string }> {
  const first = await prisma.$transaction(async (tx) => {
    const ledgerId = await claimSepayTransaction(tx, {
      tenantId: input.tenantId,
      transfer: input.transfer,
      paymentReference: input.paymentReference,
      outcome: SepayTransactionOutcome.REJECTED,
      rejectReason: input.reason,
      orderId: input.order.id,
      paymentId: input.paymentId ?? null,
    });
    if (!ledgerId) return false;
    await writeUnallocatedCashFlow(tx, {
      tenantId: input.tenantId,
      category: CashFlowCategory.UNALLOCATED_RECEIPT,
      amount: input.transfer.amount,
      ledgerId,
      method: PaymentMethod.SEPAY,
      sepayTransactionId: input.transfer.sepayTransactionId,
      paymentReference: input.paymentReference,
      description: `SePay không chốt được (${input.reason}) - đơn ${input.order.code}`,
    });
    return true;
  });
  if (!first) return { message: SEPAY_DUPLICATE_MESSAGE };

  logger.warn(
    `SePay transfer ${input.transfer.sepayTransactionId ?? input.transfer.dedupeKey} (${input.transfer.amount}) for ${input.paymentReference} rejected (${input.reason}) - ` +
      `order ${input.order.code} was not changed. Manual refund or reconciliation required.`,
  );
  const owners = await notifications.tenantOwners(input.tenantId);
  await notifications.notify({
    tenantId: input.tenantId,
    recipientIds: owners,
    referenceId: input.order.id,
    ...OrderNotificationTemplates.lateTransferNeedsAction(
      input.order.id,
      input.order.code,
      input.transfer.amount,
      input.transfer.sepayTransactionId,
      input.isPos,
    ),
  });
  return { message: 'Late transfer recorded, owner notified' };
}

/**
 * Tiền về mà không gắn được đơn nào: không có mã trong nội dung, mã không khớp khoản nào, hay tài khoản nhận không thuộc shop nào. Ghi sổ UNMATCHED rồi:
 * - biết shop: ghi sổ thu chi `UNALLOCATED_RECEIPT` (không gắn nơi nào, quỹ BANK) cùng transaction, và báo chủ shop;
 * - không biết shop (`tenantId` null): không có `tenant_id` để ghi sổ thu chi, chỉ báo operator (`notifySystem`).
 * Webhook trả `success: true` cho cả hai: SePay không cần gọi lại.
 */
export async function recordUnmatchedTransfer(
  prisma: Pick<PrismaService, '$transaction'>,
  notifications: SepayNotifier,
  logger: Pick<Logger, 'warn'>,
  input: {
    tenantId: string | null;
    transfer: SepayTransfer;
    paymentReference: string | null;
    reason: SepayRejectReason;
  },
): Promise<{ message: string }> {
  const first = await prisma.$transaction(async (tx) => {
    const ledgerId = await claimSepayTransaction(tx, {
      tenantId: input.tenantId,
      transfer: input.transfer,
      paymentReference: input.paymentReference,
      outcome: SepayTransactionOutcome.UNMATCHED,
      rejectReason: input.reason,
    });
    if (!ledgerId) return false;
    if (input.tenantId) {
      await writeUnallocatedCashFlow(tx, {
        tenantId: input.tenantId,
        category: CashFlowCategory.UNALLOCATED_RECEIPT,
        amount: input.transfer.amount,
        ledgerId,
        method: PaymentMethod.SEPAY,
        sepayTransactionId: input.transfer.sepayTransactionId,
        paymentReference: input.paymentReference,
        description: `SePay không gắn được đơn (${input.reason}): ${input.transfer.content ?? 'không có nội dung'}`,
      });
    }
    return true;
  });
  if (!first) return { message: SEPAY_DUPLICATE_MESSAGE };

  logger.warn(
    `SePay transfer ${input.transfer.sepayTransactionId ?? input.transfer.dedupeKey} (${input.transfer.amount}) is unmatched (${input.reason}) - recorded for reconciliation.`,
  );
  if (input.tenantId) {
    const owners = await notifications.tenantOwners(input.tenantId);
    await notifications.notify({
      tenantId: input.tenantId,
      recipientIds: owners,
      ...OrderNotificationTemplates.unmatchedTransfer(
        input.transfer.amount,
        input.transfer.content,
        input.transfer.sepayTransactionId,
      ),
    });
  } else {
    await notifications.notifySystem(
      OrderNotificationTemplates.unmatchedSystemTransfer(
        input.transfer.amount,
        input.transfer.accountNumber,
        input.transfer.content,
      ),
    );
  }
  return { message: 'Unmatched transfer recorded' };
}
