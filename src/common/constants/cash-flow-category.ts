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
  /** Chuyển quỹ, vế nhận: tiền mặt vào quỹ này từ quỹ khác (chủ bỏ tiền lẻ vào két, rút két về chủ). */
  FUND_TRANSFER_IN: 'FUND_TRANSFER_IN',
  /** Chuyển quỹ, vế chuyển đi. Luôn đi cặp với một FUND_TRANSFER_IN cùng số tiền. */
  FUND_TRANSFER_OUT: 'FUND_TRANSFER_OUT',
  /** Đếm két nhiều hơn sổ. */
  DRAWER_SURPLUS: 'DRAWER_SURPLUS',
  /** Đếm két ít hơn sổ (lúc chốt, hoặc lúc mở so với số để lại phiên trước). */
  DRAWER_SHORTAGE: 'DRAWER_SHORTAGE',
} as const;

export type CashFlowCategory =
  (typeof CashFlowCategory)[keyof typeof CashFlowCategory];

export const CASH_FLOW_CATEGORIES: readonly string[] =
  Object.values(CashFlowCategory);

/** Loại thu (INCOME); các loại còn lại là chi (EXPENSE). */
export const INCOME_CASH_FLOW_CATEGORIES: readonly CashFlowCategory[] = [
  CashFlowCategory.ORDER_PAYMENT,
  CashFlowCategory.UNALLOCATED_RECEIPT,
  CashFlowCategory.FUND_TRANSFER_IN,
  CashFlowCategory.DRAWER_SURPLUS,
];

/**
 * Chuyển tiền giữa các quỹ của chính shop: đổi số dư từng quỹ nhưng tổng tiền không đổi, nên mọi tổng thu / chi
 * (thẻ Tiền vào / Tiền ra, theo hạng mục) bỏ các dòng này. Chỉ bảng theo quỹ hiện chúng, ở cột chuyển đến / đi.
 */
export const TRANSFER_CASH_FLOW_CATEGORIES: readonly CashFlowCategory[] = [
  CashFlowCategory.FUND_TRANSFER_IN,
  CashFlowCategory.FUND_TRANSFER_OUT,
];

export function isTransferCategory(category: string): boolean {
  return (TRANSFER_CASH_FLOW_CATEGORIES as readonly string[]).includes(
    category,
  );
}

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
