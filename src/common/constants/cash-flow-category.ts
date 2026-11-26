import { FlowType } from '../../modules/stats/stats.constants';
import { PaymentMethod } from './payment-method';

/** `cash_flows.category`: loại tiền, quyết định hướng thu/chi; thêm loại cần migration tạo lại CHECK. */
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

/** Suy ra hướng thu/chi từ loại dòng tiền. */
export function flowTypeOf(category: CashFlowCategory): FlowType {
  return INCOME_CASH_FLOW_CATEGORIES.includes(category)
    ? FlowType.INCOME
    : FlowType.EXPENSE;
}

/** `cash_flows.fund`: tiền nằm ở két chi nhánh (DRAWER), tay chủ shop (OWNER) hay ngân hàng (BANK). */
export const CashFlowFund = {
  DRAWER: 'DRAWER',
  OWNER: 'OWNER',
  BANK: 'BANK',
} as const;

export type CashFlowFund = (typeof CashFlowFund)[keyof typeof CashFlowFund];

export const CASH_FLOW_FUNDS: readonly string[] = Object.values(CashFlowFund);

/** Chọn quỹ cho dòng tiền: không phải tiền mặt là BANK, tiền mặt vào két trừ khi giao thẳng chủ. */
export function fundOf(
  method: string | null | undefined,
  opts: { toOwner?: boolean } = {},
): CashFlowFund {
  if (method !== PaymentMethod.CASH) return CashFlowFund.BANK;
  return opts.toOwner ? CashFlowFund.OWNER : CashFlowFund.DRAWER;
}
