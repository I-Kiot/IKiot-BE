import type { Prisma } from '../../../generated/prisma/client';
import {
  CashFlowCategory,
  CashFlowFund,
  flowTypeOf,
  fundOf,
} from '../../common/constants/cash-flow-category';
import { toDong, type MoneyLike } from '../../common/utils/money';

/** Ghi sổ thu chi cho mỗi khoản thanh toán của đơn, đúng lúc tiền đổi chủ. */
export function writePaymentCashFlow(
  tx: Prisma.TransactionClient,
  flow: {
    tenantId: string;
    /** Khoản tiền đã ghi trong cùng transaction: số tiền và phương thức lấy từ đây. */
    payment: { id: string; amount: MoneyLike; method: string };
    category: CashFlowCategory;
    orderId: string;
    orderCode: string;
    locationId: string;
    createdById: string | null;
    /** Tiền mặt đã giao thẳng cho chủ shop (shipper nộp lại), không qua két. */
    handedToOwner?: boolean;
    paymentReference?: string | null;
    sepayTransactionId?: string | null;
    description: string;
  },
) {
  return tx.cashFlow.create({
    data: {
      tenantId: flow.tenantId,
      paymentId: flow.payment.id,
      orderId: flow.orderId,
      flowType: flowTypeOf(flow.category),
      category: flow.category,
      amount: toDong(flow.payment.amount),
      paymentMethod: flow.payment.method,
      fund: fundOf(flow.payment.method, { toOwner: flow.handedToOwner }),
      locationId: flow.locationId,
      createdById: flow.createdById,
      // Bộ lọc `flow=ORD` của sổ đọc tiền tố mã này, nên khoản không có mã riêng mang mã đơn (cũng là ORD…).
      paymentReference: flow.paymentReference ?? flow.orderCode,
      sepayTransactionId: flow.sepayTransactionId ?? null,
      description: flow.description,
    },
  });
}

export { CashFlowCategory, CashFlowFund };

/** Ghi sổ thu chi cho tiền SePay không thuộc đơn nào. */
export function writeUnallocatedCashFlow(
  tx: Prisma.TransactionClient,
  flow: {
    tenantId: string;
    category: CashFlowCategory;
    amount: MoneyLike;
    ledgerId: string;
    /** SEPAY cho tiền về; BANK_TRANSFER cho lần hoàn ngoài hệ thống. */
    method: string;
    createdById?: string | null;
    sepayTransactionId?: string | null;
    paymentReference?: string | null;
    description: string;
  },
) {
  return tx.cashFlow.create({
    data: {
      tenantId: flow.tenantId,
      flowType: flowTypeOf(flow.category),
      category: flow.category,
      amount: toDong(flow.amount),
      paymentMethod: flow.method,
      fund: fundOf(flow.method),
      sepayLedgerId: flow.ledgerId,
      sepayTransactionId: flow.sepayTransactionId ?? null,
      paymentReference: flow.paymentReference ?? null,
      createdById: flow.createdById ?? null,
      description: flow.description,
    },
  });
}
