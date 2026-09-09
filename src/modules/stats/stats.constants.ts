import { VIETNAM_TIMEZONE } from '../../common/constants/timezone';

/** The dashboard reads in the shop's local days, so both halves of the timezone problem live here: `TZ_OFFSET` parses a `YYYY-MM-DD` into an instant (a named zone won't parse inside `new Date()`), and `TZ_NAME` buckets instants back into local days inside Postgres. */
export const TZ_OFFSET = '+07:00';
export const TZ_NAME = VIETNAM_TIMEZONE;

/** Only completed sales are revenue - a pending or cancelled order is not money. */
export const REVENUE_STATUS = 'COMPLETED';

export const DEFAULT_RANGE_DAYS = 30;
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const GroupBy = {
  DAY: 'day',
  MONTH: 'month',
} as const;

export type GroupBy = (typeof GroupBy)[keyof typeof GroupBy];

export const GROUP_BY_VALUES: readonly string[] = Object.values(GroupBy);

/** `to_char` patterns matching Mongo's `$dateToString` formats, one per bucket size. */
export const BUCKET_FORMAT: Record<GroupBy, string> = {
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

/** How many rows the platform overview returns for its two "recent"/"top" lists. */
export const TOP_TENANTS_LIMIT = 5;
export const RECENT_INVOICES_LIMIT = 8;

/** Subscription statuses that count as a shop currently holding a plan. */
export const LIVE_SUBSCRIPTION_STATUSES = ['TRIAL', 'ACTIVE', 'PAST_DUE'];
