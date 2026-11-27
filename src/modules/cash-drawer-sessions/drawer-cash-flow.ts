import type { Prisma } from '../../../generated/prisma/client';
import {
  CashFlowCategory,
  CashFlowFund,
  flowTypeOf,
} from '../../common/constants/cash-flow-category';
import { PaymentMethod } from '../../common/constants/payment-method';

/**
 * Dòng sổ quỹ két tự ghi khi mở và chốt (2026-11-27).
 *
 * Tiền chủ bỏ vào két hay rút về không phải thu chi của shop, chỉ là tiền đổi chỗ, nên ghi là chuyển quỹ: hai dòng
 * cùng số tiền, chi ở quỹ đi và thu ở quỹ đến. Chênh lệch giữa số đếm được và sổ là tiền shop thật sự được / mất,
 * nên ghi là thừa / thiếu két. Nhờ vậy số dư quỹ Két trên sổ luôn bằng tổng tiền đang nằm trong các két.
 *
 * Mọi dòng ở đây mang `cashDrawerSessionId`, và đối soát két bỏ qua chúng: tiền đầu ca đã là `openingAmount`,
 * còn thừa / thiếu và tiền rút ghi đúng lúc chốt, sau mọi giao dịch của phiên.
 */

/** Điều chỉnh khi mở két, so tiền đầu ca với số phiên trước để lại. */
export interface OpeningAdjustment {
  /** Chủ bỏ thêm tiền lẻ: chuyển quỹ Chủ → Két. */
  ownerTopUp: number;
  /** Két hụt so với số để lại (mất qua đêm): thiếu két. */
  shortage: number;
}

/**
 * Nhiều hơn số để lại là chủ bỏ thêm; ít hơn là két mất tiền giữa hai phiên. Thừa không rõ nguồn không có ở đây:
 * ngoài đời chỉ chủ mới bỏ tiền vào két đóng.
 */
export function openingAdjustment(
  openingAmount: number,
  keptAmount: number,
): OpeningAdjustment {
  const diff = openingAmount - keptAmount;
  return {
    ownerTopUp: diff > 0 ? diff : 0,
    shortage: diff < 0 ? -diff : 0,
  };
}

/** Số phiên đã chốt để lại trong két. Phiên chốt trước khi có `withdrawnAmount` coi như không để lại gì. */
export function keptAmountOf(session: {
  finalLogAmount: Prisma.Decimal | number | null;
  withdrawnAmount: Prisma.Decimal | number | null;
}): number {
  if (session.finalLogAmount === null || session.withdrawnAmount === null) {
    return 0;
  }
  return Number(session.finalLogAmount) - Number(session.withdrawnAmount);
}

export interface DrawerFlowContext {
  tenantId: string;
  branchId: string;
  sessionId: string;
  actorId: string;
}

type Tx = Prisma.TransactionClient;

function row(
  ctx: DrawerFlowContext,
  category: CashFlowCategory,
  fund: CashFlowFund,
  amount: number,
  at: Date,
  description: string,
): Prisma.CashFlowCreateManyInput {
  return {
    tenantId: ctx.tenantId,
    flowType: flowTypeOf(category),
    amount,
    paymentMethod: PaymentMethod.CASH,
    // Cả vế quỹ Chủ cũng ghi chi nhánh, để lọc theo chi nhánh vẫn thấy đủ cặp.
    locationId: ctx.branchId,
    fund,
    category,
    description,
    createdById: ctx.actorId,
    cashDrawerSessionId: ctx.sessionId,
    createdAt: at,
  };
}

function transferRows(
  ctx: DrawerFlowContext,
  from: CashFlowFund,
  to: CashFlowFund,
  amount: number,
  at: Date,
  description: { out: string; in: string },
): Prisma.CashFlowCreateManyInput[] {
  return [
    row(
      ctx,
      CashFlowCategory.FUND_TRANSFER_OUT,
      from,
      amount,
      at,
      description.out,
    ),
    row(ctx, CashFlowCategory.FUND_TRANSFER_IN, to, amount, at, description.in),
  ];
}

const vnd = (n: number) => `${n.toLocaleString('vi-VN')}đ`;

/** Ghi sổ lúc mở két, trong transaction tạo phiên. */
export async function bookOpening(
  tx: Tx,
  ctx: DrawerFlowContext,
  input: { openingAmount: number; keptAmount: number; at: Date },
): Promise<void> {
  const { ownerTopUp, shortage } = openingAdjustment(
    input.openingAmount,
    input.keptAmount,
  );
  const rows: Prisma.CashFlowCreateManyInput[] = [];
  if (shortage > 0) {
    rows.push(
      row(
        ctx,
        CashFlowCategory.DRAWER_SHORTAGE,
        CashFlowFund.DRAWER,
        shortage,
        input.at,
        `Mở két: phiên trước để lại ${vnd(input.keptAmount)}, đếm được ${vnd(input.openingAmount)}`,
      ),
    );
  }
  if (ownerTopUp > 0) {
    rows.push(
      ...transferRows(
        ctx,
        CashFlowFund.OWNER,
        CashFlowFund.DRAWER,
        ownerTopUp,
        input.at,
        {
          out: 'Mở két: chủ đưa tiền lẻ vào két',
          in: 'Mở két: nhận tiền lẻ từ chủ',
        },
      ),
    );
  }
  if (rows.length > 0) await tx.cashFlow.createMany({ data: rows });
}

/** Ghi sổ lúc chốt két, trong transaction chốt phiên. */
export async function bookClosing(
  tx: Tx,
  ctx: DrawerFlowContext,
  input: {
    expectedAmount: number;
    countedAmount: number;
    withdrawnAmount: number;
    at: Date;
  },
): Promise<void> {
  const variance = input.countedAmount - input.expectedAmount;
  const rows: Prisma.CashFlowCreateManyInput[] = [];
  if (variance !== 0) {
    rows.push(
      row(
        ctx,
        variance > 0
          ? CashFlowCategory.DRAWER_SURPLUS
          : CashFlowCategory.DRAWER_SHORTAGE,
        CashFlowFund.DRAWER,
        Math.abs(variance),
        input.at,
        `Chốt két: sổ ${vnd(input.expectedAmount)}, đếm được ${vnd(input.countedAmount)}`,
      ),
    );
  }
  if (input.withdrawnAmount > 0) {
    // Sau dòng thừa / thiếu 1 ms để sổ luôn hiện đúng thứ tự: đếm trước, rút sau.
    const after = new Date(input.at.getTime() + 1);
    rows.push(
      ...transferRows(
        ctx,
        CashFlowFund.DRAWER,
        CashFlowFund.OWNER,
        input.withdrawnAmount,
        after,
        {
          out: 'Chốt két: chủ rút tiền về',
          in: 'Chốt két: nhận tiền từ két',
        },
      ),
    );
  }
  if (rows.length > 0) await tx.cashFlow.createMany({ data: rows });
}
