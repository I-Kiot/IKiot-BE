import type { Prisma } from '../../../generated/prisma/client';
import {
  CashFlowCategory,
  CashFlowFund,
  flowTypeOf,
  fundOf,
} from '../../common/constants/cash-flow-category';
import { toDong, type MoneyLike } from '../../common/utils/money';

/**
 * Sổ thu chi của đơn hành trình (E-5): mỗi khoản `Payment` tiền đã thật sự về tay shop hoặc rời khỏi shop là một dòng `CashFlow`, `paymentId` là unique nên không ghi trùng được.
 * Ghi đúng lúc tiền đổi chủ: cọc khi nhận, tiền thu tại quầy khi thu, QR khi webhook báo về, tiền mặt của shipper khi chủ xác nhận đã nhận (trước đó tiền còn ở tay shipper), hoàn tiền khi huỷ.
 * Cọc shop giữ lại khi huỷ không ghi thêm dòng nào: dòng thu lúc nhận cọc vẫn còn, ghi nữa là đếm hai lần.
 *
 * Nhận thẳng dòng `Payment` (không nhận số tiền rời): `CashFlow.amount = Payment.amount` luôn đúng vì chỉ có một nguồn. Hướng thu / chi suy ra từ `category`, quỹ (`fund`) từ phương thức,
 * trừ tiền mặt đã giao thẳng chủ (`handedToOwner`: shipper nộp lại) thì quỹ là OWNER và không vào két nào.
 * Đây là nơi duy nhất ghi `cash_flows` cho đơn; `cash-flow-category.spec.ts` quét `src/` để chặn `cashFlow.create` ở nơi khác.
 */
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

/**
 * Dòng sổ thu chi của tiền SePay không thuộc đơn nào (quyết định 2026-11-11, D2): tiền về mà không chốt / không gắn được đơn (`UNALLOCATED_RECEIPT`) và lần hoàn lại nó (`UNALLOCATED_REFUND`).
 * Sổ thu chi phải khớp sao kê ngân hàng nên những khoản này cũng vào sổ; không gắn đơn, không gắn nơi nào, quỹ BANK; `sepayLedgerId` trỏ về dòng `sepay_transactions` (unique theo (dòng sổ, loại), nên mỗi giao dịch có tối đa một dòng thu và một dòng hoàn).
 * Cùng với `writePaymentCashFlow` và `suppliers.service.ts`, đây là nơi duy nhất ghi `cash_flows` (`cash-flow-category.spec.ts` quét).
 */
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
