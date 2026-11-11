import { ConflictException } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client';
import {
  OPEN_QR_PAYMENT_STATUSES,
  PaymentMethod,
  PaymentRecordStatus,
} from '../../common/constants/payment-method';
import { ErrorCode } from '../../common/errors/error-codes';

/** Dữ liệu huỷ một khoản (tay): trạng thái CANCELLED cùng người huỷ và lúc huỷ. Cron QR hết hạn không dùng hàm này, nó đặt EXPIRED. */
export function cancelData(actorId: string | null, now: Date) {
  return {
    status: PaymentRecordStatus.CANCELLED,
    cancelledAt: now,
    cancelledById: actorId,
  };
}

/** Khoản QR SePay còn mở (PENDING hay EXPIRED) của đơn, mọi loại khoản (đơn quầy là FULL, đơn có giao là BALANCE). */
export function openQrPayments<T extends { method: string; status: string }>(
  payments: readonly T[],
): T[] {
  return payments.filter(
    (p) =>
      p.method === PaymentMethod.SEPAY &&
      OPEN_QR_PAYMENT_STATUSES.includes(p.status),
  );
}

/** Huỷ các khoản QR còn mở, trong transaction của người gọi, ghi ai huỷ và lúc nào. Tiền vừa về đúng lúc này thì dừng để người dùng tải lại, không ghi đè khoản đã thu. */
export async function cancelCounterQr(
  tx: Prisma.TransactionClient,
  pending: readonly { id: string }[],
  actorId: string | null,
  now: Date = new Date(),
): Promise<void> {
  for (const payment of pending) {
    const cancelled = await tx.payment.updateMany({
      where: {
        id: payment.id,
        status: { in: [...OPEN_QR_PAYMENT_STATUSES] },
      },
      data: cancelData(actorId, now),
    });
    if (cancelled.count !== 1) {
      throw new ConflictException({
        code: ErrorCode.ORDER_QR_PAYMENT_NOT_PENDING,
        message: 'The transfer has just arrived, please reload',
      });
    }
  }
}
