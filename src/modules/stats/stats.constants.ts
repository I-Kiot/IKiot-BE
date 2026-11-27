import { VIETNAM_TIMEZONE } from '../../common/constants/timezone';
import { OrderStatus } from '../../common/constants/order-status';

/** Hằng số múi giờ cho dashboard. */
export const TZ_OFFSET = '+07:00';
export const TZ_NAME = VIETNAM_TIMEZONE;

/** Chỉ đơn hoàn tất mới là doanh thu - đơn chờ hoặc đã huỷ chưa phải tiền. */
export const REVENUE_STATUS = 'COMPLETED';

export const DEFAULT_RANGE_DAYS = 30;
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const GroupBy = {
  /** Gom theo giờ, cho biểu đồ "Hôm nay". */
  HOUR: 'hour',
  DAY: 'day',
  MONTH: 'month',
} as const;

export type GroupBy = (typeof GroupBy)[keyof typeof GroupBy];

export const GROUP_BY_VALUES: readonly string[] = Object.values(GroupBy);

/** Tổng quan nền tảng trải nhiều tháng hoá đơn; gom theo giờ ở đó sẽ ra hàng nghìn dòng không ai đọc. */
export const ADMIN_GROUP_BY_VALUES: readonly string[] = [
  GroupBy.DAY,
  GroupBy.MONTH,
];

/** Gom theo giờ chỉ dùng cho "hôm nay" và "tuần này"; một năm là 8.760 điểm cho biểu đồ rộng 800px. */
export const MAX_HOURLY_RANGE_DAYS = 31;

/** Pattern `to_char` khớp định dạng `$dateToString` của Mongo, một cho mỗi cỡ bucket. */
export const BUCKET_FORMAT: Record<GroupBy, string> = {
  [GroupBy.HOUR]: 'YYYY-MM-DD"T"HH24',
  [GroupBy.DAY]: 'YYYY-MM-DD',
  [GroupBy.MONTH]: 'YYYY-MM',
};

export const FlowType = {
  INCOME: 'INCOME',
  EXPENSE: 'EXPENSE',
} as const;

export type FlowType = (typeof FlowType)[keyof typeof FlowType];

export const FLOW_TYPES: readonly string[] = Object.values(FlowType);

export const TopProductsSort = {
  QUANTITY: 'quantity',
  REVENUE: 'revenue',
} as const;

export const TOP_PRODUCTS_SORTS: readonly string[] =
  Object.values(TopProductsSort);

/** Bản cũ giới hạn danh sách tồn thấp ở 100 dòng; tổng thì tính trên tất cả. */
export const LOW_STOCK_LIST_LIMIT = 100;

export const DEFAULT_LOW_STOCK_THRESHOLD = 10;

/** Nhóm tình trạng đơn theo thứ tự hiển thị. */
export const ORDER_PIPELINE_STAGES = [
  { key: 'PENDING_CONFIRMATION', statuses: [OrderStatus.PENDING_CONFIRMATION] },
  { key: 'PROCESSING', statuses: [OrderStatus.CONFIRMED] },
  { key: 'AWAITING_SHIPMENT', statuses: [OrderStatus.PACKED] },
  {
    key: 'SHIPPING',
    statuses: [OrderStatus.PICKED_UP, OrderStatus.SHIPPING],
  },
] as const;

export const DELIVERY_FAILED_STAGE = 'DELIVERY_FAILED';

/** Số dòng mỗi danh sách cảnh báo trên dashboard; số đếm bên cạnh tính trên tất cả. */
export const ALERT_LIST_LIMIT = 5;

/** Các loại cảnh báo tồn kho. */
export const StockAlertCategory = {
  OUT_OF_STOCK: 'OUT_OF_STOCK',
  LOW_STOCK: 'LOW_STOCK',
  BELOW_MIN: 'BELOW_MIN',
  AGING: 'AGING',
} as const;

/** Mức cảnh báo hàng không bán được, theo số ngày kể từ lần bán cuối (chốt 2026-10-20). */
export const StockAgingLevel = {
  NORMAL: 'NORMAL',
  WARNING: 'WARNING',
  ATTENTION: 'ATTENTION',
  STALE: 'STALE',
} as const;

export type StockAgingLevel =
  (typeof StockAgingLevel)[keyof typeof StockAgingLevel];

/** Ngưỡng (ngày, tính từ) của từng mức: 30–59 cảnh báo, 60–89 cần chú ý, từ 90 tồn lâu ngày. */
export const STOCK_AGING_DAYS = {
  [StockAgingLevel.WARNING]: 30,
  [StockAgingLevel.ATTENTION]: 60,
  [StockAgingLevel.STALE]: 90,
} as const;

/** Số dòng tổng quan nền tảng trả về cho hai danh sách "gần đây" và "top". */
export const TOP_TENANTS_LIMIT = 5;
export const RECENT_INVOICES_LIMIT = 8;

/** Trạng thái gói còn hiệu lực, tức shop đang giữ một gói. */
export const LIVE_SUBSCRIPTION_STATUSES = ['TRIAL', 'ACTIVE', 'PAST_DUE'];
