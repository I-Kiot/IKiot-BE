import { FlowType } from '../../modules/stats/stats.constants';
import { PaymentMethod } from './payment-method';

/**
 * `cash_flows.category`: tiền này là gì (CHECK `cash_flows_category_check`). Mỗi dòng sổ thu chi có đúng một loại, và hướng thu / chi suy ra từ loại
 * (CHECK `cash_flows_category_direction`), nên không có dòng "thu" nào mang loại chi.
 * Thêm loại = migration mới tạo lại hai CHECK đó cộng một mục ở đây; `cash-flow-category.spec.ts` đọc migration để chặn lệch.
 */
export const CashFlowCategory = {
  /** Khách trả tiền cho đơn: cọc, thu tại quầy, thu khi giao, QR về, nộp tiền của shipper. */
  ORDER_PAYMENT: 'ORDER_PAYMENT',
  /** Tiền về tài khoản nhưng không gắn được với đơn nào (chuyển khoản không mã, mã lạ). */
  UNALLOCATED_RECEIPT: 'UNALLOCATED_RECEIPT',
  /** Hoàn tiền cho khách: huỷ đơn, trả hàng, trả dư. */
  ORDER_REFUND: 'ORDER_REFUND',
  /** Tiền thối khi bán tại quầy. */
  SALE_CHANGE: 'SALE_CHANGE',
  /** Trả nợ nhà cung cấp. */
  SUPPLIER_PAYMENT: 'SUPPLIER_PAYMENT',
  /** Hoàn lại khoản tiền về không gắn được với đơn. */
  UNALLOCATED_REFUND: 'UNALLOCATED_REFUND',
} as const;

export type CashFlowCategory =
  (typeof CashFlowCategory)[keyof typeof CashFlowCategory];

export const CASH_FLOW_CATEGORIES: readonly string[] =
  Object.values(CashFlowCategory);

/** Loại thu (INCOME); các loại còn lại là chi (EXPENSE). */
export const INCOME_CASH_FLOW_CATEGORIES: readonly CashFlowCategory[] = [
  CashFlowCategory.ORDER_PAYMENT,
  CashFlowCategory.UNALLOCATED_RECEIPT,
];

/** Hướng của dòng sổ suy ra từ loại: nơi gọi không tự chọn hướng, nên không ghi được dòng chi mang loại thu. */
export function flowTypeOf(category: CashFlowCategory): FlowType {
  return INCOME_CASH_FLOW_CATEGORIES.includes(category)
    ? FlowType.INCOME
    : FlowType.EXPENSE;
}

/**
 * `cash_flows.fund`: tiền nằm ở đâu (CHECK `cash_flows_fund_check`). Đối soát két (`cash-drawer-sessions`) chỉ đếm tiền mặt `DRAWER`.
 * - `DRAWER`: tiền mặt qua két của một chi nhánh (quầy). Bắt buộc có `locationId` và là tiền mặt (CHECK).
 * - `OWNER`: tiền mặt đã giao thẳng chủ shop, không qua két nào: shipper nộp lại, trả nhà cung cấp bằng tiền mặt. `locationId` của dòng OWNER chỉ để quy về chi nhánh, không vào két.
 * - `BANK`: mọi phương thức không phải tiền mặt (SePay, chuyển khoản, ví, thẻ).
 */
export const CashFlowFund = {
  DRAWER: 'DRAWER',
  OWNER: 'OWNER',
  BANK: 'BANK',
} as const;

export type CashFlowFund = (typeof CashFlowFund)[keyof typeof CashFlowFund];

export const CASH_FLOW_FUNDS: readonly string[] = Object.values(CashFlowFund);

/**
 * Quỹ của một dòng tiền: một hàm duy nhất, không nơi nào tự chọn quỹ. Không phải tiền mặt thì là `BANK`; tiền mặt vào két trừ khi `toOwner` (tiền đã giao thẳng cho chủ).
 */
export function fundOf(
  method: string | null | undefined,
  opts: { toOwner?: boolean } = {},
): CashFlowFund {
  if (method !== PaymentMethod.CASH) return CashFlowFund.BANK;
  return opts.toOwner ? CashFlowFund.OWNER : CashFlowFund.DRAWER;
}
