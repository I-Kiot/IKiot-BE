import type { Logger } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { NotificationService } from '../notifications/notifications.service';
import type { InvoiceService } from '../invoices/invoices.service';
import { OrderNotificationTemplates } from '../notifications/templates/order.templates';
import {
  FulfillmentType,
  OrderStatus,
  RemittanceStatus,
} from '../../common/constants/order-status';
import {
  OPEN_QR_PAYMENT_STATUSES,
  PaymentMethod,
  PaymentRecordStatus,
  SepayRejectReason,
  SepayTransactionOutcome,
} from '../../common/constants/payment-method';
import { OrderEventType } from '../../common/constants/order-event-type';
import { toDong } from '../../common/utils/money';
import { lockOrder } from './order-lock';
import { completedData, nextStatusAfterPayment } from './order-status';
import { postSale } from './sales-journal';
import { SalesJournalSource } from '../../common/constants/sales-journal';
import { syncOrderPaymentStatus } from './payment-status';
import { writePaymentCashFlow } from './order-cash-flow';
import { CashFlowCategory } from '../../common/constants/cash-flow-category';
import { recordOrderEvent, WEBHOOK_ACTOR } from './order-events';
import {
  claimSepayTransaction,
  decideSepayTransfer,
  isAwaitingQrTransfer,
  isQrExpired,
  rejectLateSepayTransfer,
  SEPAY_DUPLICATE_MESSAGE,
  SepayClaimLost,
  sepayTransactionSeen,
  type SepayTransfer,
} from './sepay-qr';

/**
 * Một đường chốt tiền SePay duy nhất cho đơn quầy lẫn thu khi giao / tại quầy (Phase 3-4, 2026-11-11). Trước đây `OrderService.completeSepayOrder` và `ShipmentDeliveryService.settleSepayBalance` mỗi bên tự chép các bước
 * (chiếm khoản, ghi dòng tiền, đổi đơn, sự kiện) và đã lệch nhau: một bên ném lỗi khi thiếu tiền, bên kia chỉ ghi log. Hàm thường, không DI (cùng kiểu `sepay-qr.ts`).
 *
 * Mỗi lần gọi: sổ SePay (chống lặp) → khoá đơn → chiếm khoản → dòng thu chi → suy ra trạng thái thanh toán → (nếu `nextStatusAfterPayment` cho phép) chiếm đơn COMPLETED + hoá đơn → sự kiện QR_PAID. Mọi thứ trong MỘT transaction,
 * thứ tự khoá sổ → đơn → khoản. Thua lệnh chiếm thì cuốn cả transaction (cả dòng sổ) và quyết định lại một lần, có thể ra từ chối.
 */

/** Đơn quầy (`TAKEAWAY`) hay đơn có giao / khách tới lấy: hai bên tra khoản theo cùng mã nhưng chỉ nhận khoản của loại đơn của mình. */
export type SepayScope = 'POS' | 'DELIVERY';

export interface SepayDeps {
  prisma: PrismaService;
  notifications: NotificationService;
  invoices: Pick<InvoiceService, 'issueForOrder'>;
  logger: Logger;
}

export interface SepaySettled {
  kind: 'SETTLED';
  scope: SepayScope;
  paymentId: string;
  /** Tiền thực nhận (cũng là `Payment.amount`). */
  amount: number;
  late: boolean;
  /** Chuyển thiếu so với mã QR đã yêu cầu. */
  partial: boolean;
  /** Khoản này làm đơn COMPLETED. */
  completed: boolean;
  /** Còn phải thu sau khoản này. */
  due: number;
  overpaidBy: number;
  paymentStatus: string;
  order: {
    id: string;
    tenantId: string;
    code: string;
    status: string;
    branchId: string;
    userId: string | null;
    assigneeId: string | null;
    paymentReference: string | null;
  };
}

export type SepayProcessed =
  | { kind: 'NOT_OURS' }
  | { kind: 'DUPLICATE' }
  | { kind: 'REJECTED'; message: string }
  | SepaySettled;

/** Nạp khoản SEPAY mang mã này, thuộc loại đơn của `scope`. */
function findTarget(
  prisma: PrismaService,
  tenantId: string,
  reference: string,
  scope: SepayScope,
) {
  return prisma.payment.findFirst({
    where: {
      tenantId,
      paymentReference: reference,
      method: PaymentMethod.SEPAY,
      order:
        scope === 'POS'
          ? { fulfillmentType: FulfillmentType.TAKEAWAY }
          : { fulfillmentType: { not: FulfillmentType.TAKEAWAY } },
    },
    select: {
      id: true,
      amount: true,
      requestedAmount: true,
      status: true,
      sepayTransactionId: true,
      expiresAt: true,
      createdAt: true,
      order: {
        select: {
          id: true,
          code: true,
          status: true,
          fulfillmentType: true,
          paymentStatus: true,
          assigneeId: true,
          branchId: true,
          userId: true,
          paymentReference: true,
        },
      },
    },
  });
}

type Target = NonNullable<Awaited<ReturnType<typeof findTarget>>>;

/** Lý do từ chối khi khoản không còn chờ được: đọc theo khoản rồi tới đơn, để chủ shop biết phải làm gì với số tiền. */
function rejectReasonOf(payment: Target): SepayRejectReason {
  if (payment.status === PaymentRecordStatus.PAID)
    return SepayRejectReason.ALREADY_PAID;
  if (payment.order.status === OrderStatus.CANCELLED)
    return SepayRejectReason.ORDER_CANCELLED;
  if (payment.status === PaymentRecordStatus.CANCELLED)
    return SepayRejectReason.PAYMENT_SUPERSEDED;
  if (payment.order.status === OrderStatus.COMPLETED)
    return SepayRejectReason.ALREADY_PAID;
  return SepayRejectReason.ORDER_NOT_WAITING;
}

export async function processSepayTransfer(
  deps: SepayDeps,
  input: {
    tenantId: string;
    reference: string;
    transfer: SepayTransfer;
    scope: SepayScope;
    now: Date;
  },
): Promise<SepayProcessed> {
  const { prisma, logger } = deps;
  const { tenantId, reference, transfer, scope, now } = input;

  if (await sepayTransactionSeen(prisma, tenantId, transfer)) {
    return { kind: 'DUPLICATE' };
  }

  for (let attempt = 0; ; attempt += 1) {
    const payment = await findTarget(prisma, tenantId, reference, scope);
    if (!payment) {
      return scope === 'POS'
        ? rejectLegacyPosSale(deps, input)
        : { kind: 'NOT_OURS' };
    }
    // Khoản có từ trước sổ giao dịch: SePay gọi lại đúng giao dịch đã chốt.
    if (
      payment.status === PaymentRecordStatus.PAID &&
      transfer.sepayTransactionId !== null &&
      payment.sepayTransactionId === transfer.sepayTransactionId
    ) {
      return { kind: 'DUPLICATE' };
    }

    const expired = isQrExpired(payment, now);
    if (expired) {
      logger.warn(
        `SePay transfer ${transfer.sepayTransactionId ?? transfer.dedupeKey} for ${reference} arrived after the QR expired (order ${payment.order.code} is ${payment.order.status}).`,
      );
    }
    const decision = decideSepayTransfer({
      expired,
      waiting: isAwaitingQrTransfer(payment, payment.order),
      amountDue: toDong(payment.requestedAmount ?? payment.amount),
      transferAmount: transfer.amount,
      rejectReason: rejectReasonOf(payment),
    });

    if (decision.action === 'REJECT') {
      const rejected = await rejectLateSepayTransfer(
        prisma,
        deps.notifications,
        logger,
        {
          tenantId,
          transfer,
          paymentReference: reference,
          reason: decision.reason,
          order: payment.order,
          paymentId: payment.id,
          isPos: scope === 'POS',
        },
      );
      return rejected.message === SEPAY_DUPLICATE_MESSAGE
        ? { kind: 'DUPLICATE' }
        : { kind: 'REJECTED', message: rejected.message };
    }

    try {
      return await prisma.$transaction((tx) =>
        settleInTransaction(deps, tx, {
          tenantId,
          reference,
          transfer,
          scope,
          now,
          payment,
          late: decision.late,
          partial: decision.partial,
        }),
      );
    } catch (error) {
      if (!(error instanceof SepayClaimLost) || attempt >= 1) throw error;
      // Đơn / khoản vừa đổi giữa lúc đọc và ghi: đọc lại rồi quyết định lại (có thể thành từ chối).
    }
  }
}

type Tx = Prisma.TransactionClient;

async function settleInTransaction(
  deps: SepayDeps,
  tx: Tx,
  input: {
    tenantId: string;
    reference: string;
    transfer: SepayTransfer;
    scope: SepayScope;
    now: Date;
    payment: Target;
    late: boolean;
    partial: boolean;
  },
): Promise<SepayProcessed> {
  const { tenantId, reference, transfer, scope, now, payment, late, partial } =
    input;
  const orderId = payment.order.id;

  // Sổ giao dịch trước: hai request cùng giao dịch thì request sau chờ khoá unique rồi nhận "trùng".
  const ledgerId = await claimSepayTransaction(tx, {
    tenantId,
    transfer,
    paymentReference: reference,
    outcome: partial
      ? SepayTransactionOutcome.SETTLED_PARTIAL
      : late
        ? SepayTransactionOutcome.SETTLED_LATE
        : SepayTransactionOutcome.SETTLED,
    orderId,
    paymentId: payment.id,
  });
  if (!ledgerId) return { kind: 'DUPLICATE' };
  // Khoá đơn sau dòng sổ (thứ tự khoá: sổ → đơn → các khoản), rồi đọc lại đơn: bước chờ có còn đúng không.
  await lockOrder(tx, tenantId, orderId);
  const fresh = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    select: {
      code: true,
      status: true,
      fulfillmentType: true,
      paymentStatus: true,
      branchId: true,
      userId: true,
      assigneeId: true,
      paymentReference: true,
    },
  });
  if (!isAwaitingQrTransfer(payment, fresh)) throw new SepayClaimLost();

  // Chỉ từ khoản còn mở (PENDING hay EXPIRED): webhook lặp lại, hay "khách trả tiền mặt" / mã mới vừa thắng thì không ghi gì.
  // `amount` là tiền thực về (khớp dòng sổ thu chi); số mã QR đã yêu cầu giữ ở `requestedAmount`.
  const paid = await tx.payment.updateMany({
    where: {
      id: payment.id,
      status: { in: [...OPEN_QR_PAYMENT_STATUSES] },
    },
    data: {
      status: PaymentRecordStatus.PAID,
      paidAt: now,
      sepayTransactionId: transfer.sepayTransactionId,
      amount: transfer.amount,
      requestedAmount: payment.requestedAmount ?? payment.amount,
    },
  });
  if (paid.count !== 1) throw new SepayClaimLost();

  // Số thực nhận như dòng SePay trong sao kê; không có người thao tác nên `createdById` null.
  await writePaymentCashFlow(tx, {
    tenantId,
    payment: {
      id: payment.id,
      amount: transfer.amount,
      method: PaymentMethod.SEPAY,
    },
    category: CashFlowCategory.ORDER_PAYMENT,
    orderId,
    orderCode: fresh.code,
    locationId: fresh.branchId,
    createdById: null,
    paymentReference: reference,
    sepayTransactionId: transfer.sepayTransactionId,
    description: `SePay đơn ${fresh.code}`,
  });

  // Trạng thái thanh toán suy ra từ các khoản (không đặt tay); từ đó mới biết đơn đã đủ tiền để đi tiếp chưa.
  const derived = await syncOrderPaymentStatus(tx, orderId);
  const pendingRemittance =
    (await tx.payment.count({
      where: {
        orderId,
        status: PaymentRecordStatus.PAID,
        remittanceStatus: RemittanceStatus.PENDING,
      },
    })) > 0;
  const next = nextStatusAfterPayment(fresh, derived, pendingRemittance);
  const completed = next === OrderStatus.COMPLETED;
  if (completed) {
    const claimed = await tx.order.updateMany({
      where: { id: orderId, tenantId, status: fresh.status },
      data: {
        ...completedData(now),
        // Đơn quầy lưu mã giao dịch trên đơn như trước (đơn trả lời "đã trả chưa", dòng thu chi là thứ đối soát với sao kê).
        ...(scope === 'POS'
          ? { sepayTransactionId: transfer.sepayTransactionId }
          : {}),
      },
    });
    if (claimed.count !== 1) throw new SepayClaimLost();
    // Hàng đã rời kho trước khi tới bước thu tiền này (đơn quầy trừ lúc bán, đơn giao trừ lúc xuất): ghi SALE.
    await postSale(tx, {
      orderId,
      actor: { id: null },
      now,
      source: SalesJournalSource.SEPAY_WEBHOOK,
    });
  }
  if (derived.overpaidBy > 0) {
    // Cột này chỉ ghi ở đây, trong transaction đã chèn dòng sổ: dòng sổ không bị sửa về sau (trừ bốn cột xử lý tay).
    await tx.sepayTransaction.update({
      where: { id: ledgerId },
      data: { excessAmount: derived.overpaidBy },
    });
  }

  await recordOrderEvent(tx, WEBHOOK_ACTOR, {
    tenantId,
    orderId,
    type: OrderEventType.QR_PAID,
    fromStatus: completed ? fresh.status : null,
    toStatus: completed ? OrderStatus.COMPLETED : null,
    metadata: {
      paymentId: payment.id,
      amount: transfer.amount,
      method: PaymentMethod.SEPAY,
      sepayTransactionId: transfer.sepayTransactionId,
      paymentReference: reference,
      orderSettled: completed,
      ...(late ? { lateAfterExpiry: true } : {}),
      ...(partial
        ? {
            partial: true,
            requested: toDong(payment.requestedAmount ?? payment.amount),
          }
        : {}),
      due: derived.due,
      ...(derived.overpaidBy > 0 ? { overpaidBy: derived.overpaidBy } : {}),
    },
  });
  if (completed) {
    await deps.invoices.issueForOrder(tx, orderId, null);
  }

  return {
    kind: 'SETTLED',
    scope,
    paymentId: payment.id,
    amount: transfer.amount,
    late,
    partial,
    completed,
    due: derived.due,
    overpaidBy: derived.overpaidBy,
    paymentStatus: derived.status,
    order: {
      id: orderId,
      tenantId,
      code: fresh.code,
      status: completed ? OrderStatus.COMPLETED : fresh.status,
      branchId: fresh.branchId,
      userId: fresh.userId,
      assigneeId: fresh.assigneeId,
      paymentReference: fresh.paymentReference,
    },
  };
}

/**
 * Đơn quầy lập trước Phase 3 không có dòng `Payment`: khoản chờ của nó là chính đơn, không còn nơi để chốt. Tiền vẫn về nên ghi sổ REJECTED (+ dòng thu chi chưa gắn đơn) và báo chủ shop; không có đơn quầy nào mang mã này thì không phải của ta.
 * Chỉ dữ liệu mẫu có loại đơn này.
 */
async function rejectLegacyPosSale(
  deps: SepayDeps,
  input: { tenantId: string; reference: string; transfer: SepayTransfer },
): Promise<SepayProcessed> {
  const order = await deps.prisma.order.findFirst({
    where: {
      tenantId: input.tenantId,
      paymentReference: input.reference,
      fulfillmentType: FulfillmentType.TAKEAWAY,
    },
    select: { id: true, code: true, status: true },
  });
  if (!order) return { kind: 'NOT_OURS' };
  const rejected = await rejectLateSepayTransfer(
    deps.prisma,
    deps.notifications,
    deps.logger,
    {
      tenantId: input.tenantId,
      transfer: input.transfer,
      paymentReference: input.reference,
      reason:
        order.status === OrderStatus.CANCELLED
          ? SepayRejectReason.ORDER_CANCELLED
          : order.status === OrderStatus.COMPLETED
            ? SepayRejectReason.ALREADY_PAID
            : SepayRejectReason.ORDER_NOT_WAITING,
      order,
      isPos: true,
    },
  );
  return rejected.message === SEPAY_DUPLICATE_MESSAGE
    ? { kind: 'DUPLICATE' }
    : { kind: 'REJECTED', message: rejected.message };
}

/**
 * Thông báo sau commit cho một khoản đã chốt (không bao giờ ném lỗi): người lên đơn + quản lý (đơn quầy) hay người phụ trách (đơn giao / khách tới lấy).
 * Còn thiếu tiền thì báo "chuyển thiếu, còn X"; trả dư thì báo chủ shop (quyết định 5: hoàn phần dư là việc của chủ).
 */
export async function notifySettled(
  deps: Pick<SepayDeps, 'notifications'>,
  settled: SepaySettled,
): Promise<void> {
  const { order } = settled;
  const isPos = settled.scope === 'POS';
  const recipients: (string | null)[] = isPos
    ? [
        order.userId,
        ...(await deps.notifications.managersOfLocation({
          tenantId: order.tenantId,
          locationId: order.branchId,
        })),
      ]
    : [order.assigneeId];
  const content =
    settled.due > 0
      ? OrderNotificationTemplates.partialTransfer(
          order.id,
          order.code,
          settled.amount,
          settled.due,
          isPos,
        )
      : isPos
        ? OrderNotificationTemplates.paid(
            order.paymentReference ?? order.code,
            settled.amount,
          )
        : OrderNotificationTemplates.deliveryTransferReceived(
            order.code,
            settled.amount,
          );
  if (recipients.some(Boolean)) {
    await deps.notifications.notify({
      tenantId: order.tenantId,
      recipientIds: recipients,
      referenceId: order.id,
      ...content,
    });
  }
  if (settled.overpaidBy > 0) {
    const owners = await deps.notifications.tenantOwners(order.tenantId);
    await deps.notifications.notify({
      tenantId: order.tenantId,
      recipientIds: owners,
      referenceId: order.id,
      ...OrderNotificationTemplates.overpaid(
        order.id,
        order.code,
        settled.overpaidBy,
      ),
    });
  }
}
