import { OrderStatus } from '../../../common/constants/order-status';
import { PaymentMethod } from '../../../common/constants/payment-method';
import {
  CashFlowCategory,
  CashFlowFund,
} from '../../../common/constants/cash-flow-category';

/**
 * Tên tiếng Việt của các mã in trong file báo cáo. File xuất là giấy tờ đưa cho kế toán nên không thể in mã thô như API trả cho dashboard (dashboard tự dịch ở FE).
 * Cùng câu chữ với `iKiotMS-FE/src/lib/stats-format.ts`; mã chưa có tên thì in nguyên mã.
 */

const ORDER_STATUS_LABELS: Record<string, string> = {
  [OrderStatus.PENDING_CONFIRMATION]: 'Chờ xác nhận',
  [OrderStatus.PENDING]: 'Chờ thanh toán',
  [OrderStatus.CONFIRMED]: 'Đã xác nhận',
  [OrderStatus.PACKED]: 'Đã đóng gói',
  [OrderStatus.PICKED_UP]: 'Đã bàn giao',
  [OrderStatus.SHIPPING]: 'Đang giao',
  [OrderStatus.RECEIVED]: 'Đã nhận hàng',
  [OrderStatus.COMPLETED]: 'Hoàn tất',
  [OrderStatus.CANCELLED]: 'Đã huỷ',
  [OrderStatus.RETURNED]: 'Trả hàng',
  [OrderStatus.DRAFT]: 'Nháp',
  [OrderStatus.READY_TO_PACK]: 'Sẵn sàng đóng gói',
  [OrderStatus.DELIVERED]: 'Đã giao',
};

const PAYMENT_METHOD_LABELS: Record<string, string> = {
  [PaymentMethod.CASH]: 'Tiền mặt',
  [PaymentMethod.BANK_TRANSFER]: 'Chuyển khoản',
  [PaymentMethod.MOMO]: 'MoMo',
  [PaymentMethod.VNPAY]: 'VNPay',
  [PaymentMethod.SEPAY]: 'SePay',
  UNKNOWN: 'Chưa xác định',
};

const CASH_FLOW_CATEGORY_LABELS: Record<string, string> = {
  [CashFlowCategory.ORDER_PAYMENT]: 'Thu tiền đơn hàng',
  [CashFlowCategory.ORDER_REFUND]: 'Hoàn tiền đơn hàng',
  [CashFlowCategory.SALE_CHANGE]: 'Tiền thối cho khách',
  [CashFlowCategory.SUPPLIER_PAYMENT]: 'Trả nhà cung cấp',
  [CashFlowCategory.UNALLOCATED_RECEIPT]: 'Tiền về chưa gắn đơn',
  [CashFlowCategory.UNALLOCATED_REFUND]: 'Hoàn tiền chưa gắn đơn',
};

const FUND_LABELS: Record<string, string> = {
  [CashFlowFund.DRAWER]: 'Két',
  [CashFlowFund.OWNER]: 'Quỹ chủ',
  [CashFlowFund.BANK]: 'Ngân hàng',
};

const SEPAY_OUTCOME_LABELS: Record<string, string> = {
  SETTLED: 'Đã chốt',
  SETTLED_LATE: 'Đã chốt (QR hết hạn)',
  SETTLED_PARTIAL: 'Chuyển thiếu',
  REJECTED: 'Không chốt được',
  UNMATCHED: 'Không gắn được đơn',
};

const labelFrom =
  (labels: Record<string, string>) =>
  (code: string | null | undefined): string =>
    (code && labels[code]) || code || '';

export const orderStatusLabel = labelFrom(ORDER_STATUS_LABELS);
export const paymentMethodLabel = labelFrom(PAYMENT_METHOD_LABELS);
export const cashFlowCategoryLabel = labelFrom(CASH_FLOW_CATEGORY_LABELS);
export const fundLabel = labelFrom(FUND_LABELS);
export const sepayOutcomeLabel = labelFrom(SEPAY_OUTCOME_LABELS);
