import { VIETNAM_TIMEZONE } from '../../common/constants/timezone';
import { OrderStatus } from '../../common/constants/order-status';

/** The dashboard reads in the shop's local days, so both halves of the timezone problem live here: `TZ_OFFSET` parses a `YYYY-MM-DD` into an instant (a named zone won't parse inside `new Date()`), and `TZ_NAME` buckets instants back into local days inside Postgres. */
export const TZ_OFFSET = '+07:00';
export const TZ_NAME = VIETNAM_TIMEZONE;

/** Only completed sales are revenue - a pending or cancelled order is not money. */
export const REVENUE_STATUS = 'COMPLETED';

export const DEFAULT_RANGE_DAYS = 30;
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const GroupBy = {
  /** Added 2026-10-20 for the dashboard's "Hôm nay" chart - a single day bucketed by day is one point. Shop revenue only; the platform overview keeps day/month. */
  HOUR: 'hour',
  DAY: 'day',
  MONTH: 'month',
} as const;

export type GroupBy = (typeof GroupBy)[keyof typeof GroupBy];

export const GROUP_BY_VALUES: readonly string[] = Object.values(GroupBy);

/** The platform overview spans months of invoices; hourly buckets there would be thousands of rows nobody reads. */
export const ADMIN_GROUP_BY_VALUES: readonly string[] = [
  GroupBy.DAY,
  GroupBy.MONTH,
];

/** Hourly buckets are for "today" and "this week"; a year of them is 8,760 points for a chart 800px wide. */
export const MAX_HOURLY_RANGE_DAYS = 31;

/** `to_char` patterns matching Mongo's `$dateToString` formats, one per bucket size. */
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

/** The old service capped the low-stock list at 100 rows; the totals cover everything. */
export const LOW_STOCK_LIST_LIMIT = 100;

export const DEFAULT_LOW_STOCK_THRESHOLD = 10;

/** Các nhóm "tình trạng đơn" trên dashboard, mỗi nhóm là những trạng thái hành trình nó gom lại. Thứ tự là thứ tự hiển thị. "Giao thất bại" không phải một trạng thái đơn (đơn vẫn SHIPPING, chuyến giao FAILED chờ giao lại hoặc xác nhận hàng về) nên được đếm riêng, xem `getOrderPipeline`. */
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

/** How many rows each dashboard alert list shows; the counts beside them cover everything. */
export const ALERT_LIST_LIMIT = 5;

/** Bốn loại cảnh báo tồn kho trên dashboard. Một dòng tồn có thể thuộc nhiều loại cùng lúc (vừa dưới mức tối thiểu vừa lâu không bán). */
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

/** How many rows the platform overview returns for its two "recent"/"top" lists. */
export const TOP_TENANTS_LIMIT = 5;
export const RECENT_INVOICES_LIMIT = 8;

/** Subscription statuses that count as a shop currently holding a plan. */
export const LIVE_SUBSCRIPTION_STATUSES = ['TRIAL', 'ACTIVE', 'PAST_DUE'];
