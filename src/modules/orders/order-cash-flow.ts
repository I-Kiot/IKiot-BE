import type { Prisma } from '../../../generated/prisma/client';
import { FlowType } from '../stats/stats.constants';

/**
 * Sổ thu chi của đơn hành trình (E-5): mỗi khoản `Payment` tiền đã thật sự về tay shop hoặc rời khỏi shop là một dòng `CashFlow`, `paymentId` là unique nên không ghi trùng được.
 * Ghi đúng lúc tiền đổi chủ: cọc khi nhận, tiền thu tại quầy khi thu, QR khi webhook báo về, tiền mặt của shipper khi chủ xác nhận đã nhận (trước đó tiền còn ở tay shipper), hoàn tiền khi huỷ.
 * Cọc shop giữ lại khi huỷ không ghi thêm dòng nào: dòng thu lúc nhận cọc vẫn còn, ghi nữa là đếm hai lần.
 */
export function writePaymentCashFlow(
  tx: Prisma.TransactionClient,
  flow: {
    tenantId: string;
    paymentId: string;
    orderId: string;
    orderCode: string;
    flowType: FlowType;
    amount: number;
    method: string;
    locationId: string;
    createdById: string | null;
    paymentReference?: string | null;
    sepayTransactionId?: string | null;
    description: string;
  },
) {
  return tx.cashFlow.create({
    data: {
      tenantId: flow.tenantId,
      paymentId: flow.paymentId,
      orderId: flow.orderId,
      flowType: flow.flowType,
      amount: flow.amount,
      paymentMethod: flow.method,
      locationId: flow.locationId,
      createdById: flow.createdById,
      // Bộ lọc `flow=ORD` của sổ đọc tiền tố mã này, nên khoản không có mã riêng mang mã đơn (cũng là ORD…).
      paymentReference: flow.paymentReference ?? flow.orderCode,
      sepayTransactionId: flow.sepayTransactionId ?? null,
      description: flow.description,
    },
  });
}
