import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { paginate, skipFor } from '../../common/utils/pagination';
import type { AuthUser } from '../../common/types/auth-user.type';
import { ErrorCode } from '../../common/errors/error-codes';
import {
  OrderStatus,
  STOCKED_LINE_TYPES,
} from '../../common/constants/order-status';
import { ShipmentStatus } from '../../common/constants/shipment-status';
import { InventoryTxType } from '../../common/constants/inventory-ledger';
import { LocationStatus } from '../../common/constants/location-status';
import { locationScope, orderScope } from './stats-scope';
import {
  averageOrderValue,
  businessDatesOf,
  changePct,
  comparisonWindows,
  exceedsHourlyRange,
  previousBusinessDates,
  previousPeriod,
  stockAgingLevel,
  type BusinessDateRange,
  type DateRange,
} from './stats-math';
import {
  ALERT_LIST_LIMIT,
  BUCKET_FORMAT,
  DEFAULT_LOW_STOCK_THRESHOLD,
  DELIVERY_FAILED_STAGE,
  FlowType,
  GroupBy,
  LOW_STOCK_LIST_LIMIT,
  MAX_HOURLY_RANGE_DAYS,
  ORDER_PIPELINE_STAGES,
  REVENUE_STATUS,
  STOCK_AGING_DAYS,
  StockAgingLevel,
  StockAlertCategory,
  TZ_NAME,
  TopProductsSort,
} from './stats.constants';
import type {
  CashflowListQueryDto,
  CashflowQueryDto,
  InventoryStatsQueryDto,
  OrderPipelineQueryDto,
  RevenueByStaffQueryDto,
  RevenueByBranchQueryDto,
  RevenueComparisonQueryDto,
  RevenueSeriesQueryDto,
  SlowProductsQueryDto,
  StatsQueryDto,
  StockAlertsQueryDto,
  TopCustomersQueryDto,
  TopProductsQueryDto,
} from './dto/stats-query.dto';
import {
  LOCATION_TYPE_SELECT,
  columnsOfLocation,
  locationRefOf,
  postingWhere,
  withNamedPosting,
} from '../../common/dto/location-ref.dto';

/** `COUNT(*)` là `bigint` trong Postgres; mọi số đếm dưới đây được ép `::int` ngay trong SQL. */
interface SummaryRow {
  revenue: Prisma.Decimal;
  grossSales: Prisma.Decimal;
  returns: Prisma.Decimal;
  goodsRevenue: Prisma.Decimal;
  shippingRevenue: Prisma.Decimal;
  otherIncome: Prisma.Decimal;
  costOfGoods: Prisma.Decimal;
  shippingCost: Prisma.Decimal;
  channelFee: Prisma.Decimal;
  orderCount: number;
  returnCount: number;
  customerCount: number;
}

/** Một dòng tồn trong danh sách cảnh báo. */
interface StockAlertRow {
  category: string;
  inventoryId: string;
  productItemId: string;
  productName: string;
  sku: string | null;
  locationId: string;
  locationName: string;
  locationType: string;
  shelf: number;
  minStock: number;
  daysIdle: number | null;
}

interface BucketRow {
  bucket: string;
  revenue: Prisma.Decimal;
  returns: Prisma.Decimal;
  orderCount: number;
}

/** Ghép họ tên, null khi chưa có tên. */
function fullName(
  user: {
    profileFirstName: string | null;
    profileLastName: string | null;
  } | null,
): string | null {
  if (!user?.profileFirstName) return null;
  return `${user.profileFirstName} ${user.profileLastName ?? ''}`.trim();
}

/** Thống kê dashboard shop, nhiều truy vấn raw SQL. */

/** Cột người được tính doanh thu trên sổ doanh thu, theo cách gom. */
const STAFF_COLUMN: Record<string, Prisma.Sql> = {
  seller: Prisma.sql`e.seller_id`,
  assignee: Prisma.sql`COALESCE(e.assignee_id, e.creator_id)`,
  creator: Prisma.sql`e.creator_id`,
};

/** Phân trang bảng xếp hạng trong bộ nhớ; `summary` luôn là tổng cả kỳ. */
function pageOfRanking<T extends { revenue: number; orderCount: number }>(
  all: T[],
  query: { page?: number; limit?: number },
) {
  const revenue = all.reduce((n, row) => n + row.revenue, 0);
  const orderCount = all.reduce((n, row) => n + row.orderCount, 0);
  const summary = {
    revenue,
    orderCount,
    aov: averageOrderValue(revenue, orderCount),
  };
  if (!query.limit) return { rows: all, summary, pagination: undefined };
  const page = query.page ?? 1;
  const { data, pagination } = paginate(
    all.slice(
      skipFor(page, query.limit),
      skipFor(page, query.limit) + query.limit,
    ),
    all.length,
    page,
    query.limit,
  );
  return { rows: data, summary, pagination };
}

@Injectable()
export class StatsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Điều kiện chung của truy vấn sổ doanh thu. */
  private journalFilter(
    tenantId: string | null,
    branchId: string | undefined,
    { from, to }: BusinessDateRange,
    alias = 'e',
  ) {
    const a = Prisma.raw(alias);
    return Prisma.sql`${a}.tenant_id = ${tenantId}
      AND ${a}.business_date >= ${from}::date
      AND ${a}.business_date <= ${to}::date
      ${branchId ? Prisma.sql`AND ${a}.branch_id = ${branchId}` : Prisma.empty}`;
  }

  /** KPI chính kèm % so với kỳ trước. */
  async getOverview(user: AuthUser, query: StatsQueryDto) {
    const scope = orderScope(user, query.branchId);
    const range = query.range();
    const previous = previousPeriod(range);
    const dates = businessDatesOf(range);

    const [current, before, gap] = await Promise.all([
      this.summarize(user, scope, dates),
      this.summarize(user, scope, previousBusinessDates(dates)),
      this.journalGap(user, scope, dates),
    ]);

    return {
      ...current,
      changePct: {
        revenue: changePct(current.revenue, before.revenue),
        orderCount: changePct(current.orderCount, before.orderCount),
        customerCount: changePct(current.customerCount, before.customerCount),
        aov: changePct(current.aov, before.aov),
        grossProfit: changePct(current.grossProfit, before.grossProfit),
      },
      journalGap: gap,
      period: range,
      previousPeriod: previous,
    };
  }

  /** Số đơn COMPLETED trong kỳ chưa có bút toán SALE. */
  private async journalGap(
    user: AuthUser,
    scope: { branchId?: string },
    { from, to }: BusinessDateRange,
  ) {
    const rows = await this.prisma.$queryRaw<
      { missing: number; firstJournalAt: Date | null }[]
    >`
      SELECT (SELECT COUNT(*)::int FROM orders o
               WHERE o.tenant_id = ${user.tenantId}
                 AND o.status = ${REVENUE_STATUS}
                 AND (o.completed_at AT TIME ZONE ${TZ_NAME})::date >= ${from}::date
                 AND (o.completed_at AT TIME ZONE ${TZ_NAME})::date <= ${to}::date
                 ${scope.branchId ? Prisma.sql`AND o.branch_id = ${scope.branchId}` : Prisma.empty}
                 AND NOT EXISTS (SELECT 1 FROM sales_journal_entries s
                                  WHERE s.order_id = o.id AND s.entry_type = 'SALE')) AS "missing",
             (SELECT MIN(posted_at) FROM sales_journal_entries
               WHERE tenant_id = ${user.tenantId}) AS "firstJournalAt"
    `;
    return {
      ordersWithoutJournal: rows[0]?.missing ?? 0,
      firstJournalAt: rows[0]?.firstJournalAt ?? null,
    };
  }

  private async summarize(
    user: AuthUser,
    scope: { branchId?: string },
    dates: BusinessDateRange,
  ) {
    const filter = this.journalFilter(user.tenantId, scope.branchId, dates);

    const [rows, missing] = await Promise.all([
      this.prisma.$queryRaw<SummaryRow[]>`
        SELECT COALESCE(SUM(e.total_amount), 0) AS "revenue",
               COALESCE(SUM(e.total_amount) FILTER (WHERE e.entry_type = 'SALE'), 0) AS "grossSales",
               COALESCE(SUM(e.total_amount) FILTER (WHERE e.entry_type = 'RETURN'), 0) AS "returns",
               COALESCE(SUM(e.goods_amount), 0) AS "goodsRevenue",
               COALESCE(SUM(e.shipping_amount), 0) AS "shippingRevenue",
               COALESCE(SUM(e.other_income_amount), 0) AS "otherIncome",
               COALESCE(SUM(e.cogs_amount), 0) AS "costOfGoods",
               COALESCE(SUM(e.shipping_cost), 0) AS "shippingCost",
               COALESCE(SUM(e.channel_fee), 0) AS "channelFee",
               (COUNT(*) FILTER (WHERE e.entry_type = 'SALE'))::int AS "orderCount",
               (COUNT(*) FILTER (WHERE e.entry_type = 'RETURN'))::int AS "returnCount",
               (COUNT(DISTINCT e.customer_id) FILTER (WHERE e.entry_type = 'SALE'))::int AS "customerCount"
        FROM sales_journal_entries e
        WHERE ${filter}
      `,
      // Dòng giữ hàng (PRODUCT, món trong combo) mà sổ kho không có giá vốn: lợi nhuận đang bị thổi lên.
      this.prisma.$queryRaw<{ linesMissingCost: number }[]>`
        SELECT COUNT(*)::int AS "linesMissingCost"
        FROM sales_journal_lines l
        JOIN sales_journal_entries e ON e.id = l.entry_id
        JOIN order_items oi ON oi.id = l.order_item_id
        WHERE ${filter}
          AND e.entry_type = 'SALE'
          AND l.cogs = 0
          AND oi.line_type IN (${Prisma.join([...STOCKED_LINE_TYPES])})
      `,
    ]);
    const row = rows[0];
    const revenue = Number(row?.revenue ?? 0);
    const orderCount = row?.orderCount ?? 0;
    const costOfGoods = Number(row?.costOfGoods ?? 0);
    const shippingCost = Number(row?.shippingCost ?? 0);
    const channelFee = Number(row?.channelFee ?? 0);
    return {
      // Doanh thu ròng = bán + hàng trả (âm) + thu nhập khác.
      revenue,
      grossSales: Number(row?.grossSales ?? 0),
      returns: Number(row?.returns ?? 0),
      goodsRevenue: Number(row?.goodsRevenue ?? 0),
      shippingRevenue: Number(row?.shippingRevenue ?? 0),
      otherIncome: Number(row?.otherIncome ?? 0),
      costOfGoods,
      shippingCost,
      channelFee,
      orderCount,
      returnCount: row?.returnCount ?? 0,
      customerCount: row?.customerCount ?? 0,
      aov: averageOrderValue(revenue, orderCount),
      // Lợi nhuận gộp = doanh thu ròng - giá vốn - phí vận chuyển - phí sàn.
      grossProfit: revenue - costOfGoods - shippingCost - channelFee,
      linesMissingCost: missing[0]?.linesMissingCost ?? 0,
    };
  }

  /** Doanh thu theo thời gian từ sổ doanh thu. */
  async getRevenueSeries(user: AuthUser, query: RevenueSeriesQueryDto) {
    const scope = orderScope(user, query.branchId);
    const range = query.range();
    const groupBy = query.groupBy ?? GroupBy.DAY;

    if (groupBy === GroupBy.HOUR && exceedsHourlyRange(range)) {
      throw new BadRequestException({
        code: ErrorCode.STATS_HOURLY_RANGE_TOO_LONG,
        message: `Hourly buckets cover at most ${MAX_HOURLY_RANGE_DAYS} days`,
      });
    }

    const bucketExpr =
      groupBy === GroupBy.HOUR
        ? Prisma.sql`to_char(e.posted_at AT TIME ZONE ${TZ_NAME}, ${BUCKET_FORMAT[groupBy]})`
        : Prisma.sql`to_char(e.business_date, ${BUCKET_FORMAT[groupBy]})`;

    const rows = await this.prisma.$queryRaw<BucketRow[]>`
      SELECT ${bucketExpr} AS "bucket",
             COALESCE(SUM(e.total_amount), 0) AS "revenue",
             COALESCE(SUM(e.total_amount) FILTER (WHERE e.entry_type = 'RETURN'), 0) AS "returns",
             (COUNT(*) FILTER (WHERE e.entry_type = 'SALE'))::int AS "orderCount"
      FROM sales_journal_entries e
      WHERE ${this.journalFilter(user.tenantId, scope.branchId, businessDatesOf(range))}
      GROUP BY 1
      ORDER BY 1
    `;

    return {
      groupBy,
      series: rows.map((row) => ({
        bucket: row.bucket,
        revenue: Number(row.revenue),
        returns: Number(row.returns),
        orderCount: row.orderCount,
      })),
    };
  }

  /** Tiền thu theo phương thức, theo tiền thực thu. */
  async getRevenueByPaymentMethod(user: AuthUser, query: StatsQueryDto) {
    const scope = orderScope(user, query.branchId);
    const { fromDate, toDate } = query.range();

    const rows = await this.prisma.$queryRaw<
      {
        paymentMethod: string | null;
        received: Prisma.Decimal;
        refunded: Prisma.Decimal;
        change: Prisma.Decimal;
        orderCount: number;
      }[]
    >`
      SELECT cf.payment_method AS "paymentMethod",
             COALESCE(SUM(cf.amount) FILTER (WHERE cf.category = 'ORDER_PAYMENT'), 0) AS "received",
             COALESCE(SUM(cf.amount) FILTER (WHERE cf.category = 'ORDER_REFUND'), 0) AS "refunded",
             COALESCE(SUM(cf.amount) FILTER (WHERE cf.category = 'SALE_CHANGE'), 0) AS "change",
             (COUNT(DISTINCT cf.order_id) FILTER (WHERE cf.category = 'ORDER_PAYMENT'))::int AS "orderCount"
      FROM cash_flows cf
      WHERE cf.tenant_id = ${user.tenantId}
        AND cf.category IN ('ORDER_PAYMENT', 'ORDER_REFUND', 'SALE_CHANGE')
        AND cf.created_at >= ${fromDate}
        AND cf.created_at <= ${toDate}
        ${scope.branchId ? Prisma.sql`AND cf.location_id = ${scope.branchId}` : Prisma.empty}
      GROUP BY 1
    `;

    return {
      basis: 'CASH',
      breakdown: rows
        .map((row) => {
          const received = Number(row.received);
          const refunded = Number(row.refunded);
          const change = Number(row.change);
          return {
            paymentMethod: row.paymentMethod ?? 'UNKNOWN',
            revenue: received - refunded - change,
            received,
            refunded,
            change,
            orderCount: row.orderCount,
          };
        })
        .sort((a, b) => b.revenue - a.revenue),
    };
  }

  /** Doanh thu theo nhân viên bán hàng, người phụ trách, người lên đơn hoặc người thu tiền. */
  async getRevenueByStaff(user: AuthUser, query: RevenueByStaffQueryDto) {
    const scope = orderScope(user, query.branchId);
    const range = query.range();
    const groupBy = query.groupBy;

    type StaffRow = {
      userId: string | null;
      revenue: Prisma.Decimal;
      orderCount: number;
    };
    const rows =
      groupBy === 'collector'
        ? await this.prisma.$queryRaw<StaffRow[]>`
            SELECT p.collected_by AS "userId",
                   COALESCE(SUM(cf.amount), 0) AS "revenue",
                   COUNT(DISTINCT cf.order_id)::int AS "orderCount"
            FROM cash_flows cf
            JOIN payments p ON p.id = cf.payment_id
            WHERE cf.tenant_id = ${user.tenantId}
              AND cf.category = 'ORDER_PAYMENT'
              AND cf.created_at >= ${range.fromDate}
              AND cf.created_at <= ${range.toDate}
              ${scope.branchId ? Prisma.sql`AND cf.location_id = ${scope.branchId}` : Prisma.empty}
            GROUP BY 1
          `
        : await this.prisma.$queryRaw<StaffRow[]>`
            SELECT ${STAFF_COLUMN[groupBy] ?? STAFF_COLUMN.seller} AS "userId",
                   COALESCE(SUM(e.total_amount), 0) AS "revenue",
                   (COUNT(*) FILTER (WHERE e.entry_type = 'SALE'))::int AS "orderCount"
            FROM sales_journal_entries e
            WHERE ${this.journalFilter(user.tenantId, scope.branchId, businessDatesOf(range))}
            GROUP BY 1
          `;

    const staff = await this.prisma.user.findMany({
      where: {
        id: {
          in: rows
            .map((row) => row.userId)
            .filter((id): id is string => id !== null),
        },
      },
      select: { id: true, profileFirstName: true, profileLastName: true },
    });
    const nameOf = new Map(staff.map((s) => [s.id, fullName(s)]));

    const all = rows
      .map((row) => {
        const revenue = Number(row.revenue);
        return {
          userId: row.userId,
          // Không có người gắn (đơn đồng bộ từ kênh bán, hoặc khoản thu không ghi người thu) thì không có tên.
          staffName: row.userId ? (nameOf.get(row.userId) ?? null) : null,
          revenue,
          orderCount: row.orderCount,
          aov: averageOrderValue(revenue, row.orderCount),
        };
      })
      .sort((a, b) => b.revenue - a.revenue);

    const { rows: staffRows, summary, pagination } = pageOfRanking(all, query);
    return { groupBy, staff: staffRows, summary, pagination };
  }

  /** Hàng bán chạy từ dòng sổ doanh thu. */
  async getTopProducts(user: AuthUser, query: TopProductsQueryDto) {
    const scope = orderScope(user, query.branchId);
    const sortBy =
      query.sortBy === TopProductsSort.REVENUE
        ? TopProductsSort.REVENUE
        : TopProductsSort.QUANTITY;

    // Cột ORDER BY lấy từ hai giá trị cố định.
    const orderColumn = Prisma.raw(`"${sortBy}"`);

    const rows = await this.prisma.$queryRaw<
      {
        productItemId: string;
        productName: string | null;
        quantity: Prisma.Decimal;
        revenue: Prisma.Decimal;
      }[]
    >`
      SELECT l.product_item_id AS "productItemId",
             MIN(oi.product_name) AS "productName",
             COALESCE(SUM(l.quantity), 0) AS "quantity",
             COALESCE(SUM(l.amount), 0) AS "revenue"
      FROM sales_journal_lines l
      JOIN sales_journal_entries e ON e.id = l.entry_id
      JOIN order_items oi ON oi.id = l.order_item_id
      WHERE ${this.journalFilter(user.tenantId, scope.branchId, businessDatesOf(query.range()))}
      GROUP BY l.product_item_id
      ORDER BY ${orderColumn} DESC
      LIMIT ${query.limit}
    `;

    return {
      sortBy,
      products: rows.map((row) => ({
        productItemId: row.productItemId,
        productName: row.productName,
        quantity: Number(row.quantity),
        revenue: Number(row.revenue),
      })),
    };
  }

  /** Doanh thu năm mốc lịch so với cùng khoảng kỳ trước. */
  async getRevenueComparison(user: AuthUser, query: RevenueComparisonQueryDto) {
    const scope = orderScope(user, query.branchId);
    const windows = comparisonWindows(new Date());

    const sum = async (range: DateRange) => {
      const rows = await this.prisma.$queryRaw<
        { revenue: Prisma.Decimal; orderCount: number }[]
      >`
        SELECT COALESCE(SUM(e.total_amount), 0) AS "revenue",
               (COUNT(*) FILTER (WHERE e.entry_type = 'SALE'))::int AS "orderCount"
        FROM sales_journal_entries e
        WHERE ${this.journalFilter(user.tenantId, scope.branchId, businessDatesOf(range))}
      `;
      const revenue = Number(rows[0]?.revenue ?? 0);
      const orderCount = rows[0]?.orderCount ?? 0;
      return {
        ...range,
        revenue,
        orderCount,
        aov: averageOrderValue(revenue, orderCount),
      };
    };

    const comparisons = await Promise.all(
      windows.map(async (w) => {
        const [current, previous] = await Promise.all([
          sum(w.current),
          sum(w.previous),
        ]);
        return {
          key: w.key,
          current,
          previous,
          changePct: {
            revenue: changePct(current.revenue, previous.revenue),
            orderCount: changePct(current.orderCount, previous.orderCount),
            aov: changePct(current.aov, previous.aov),
          },
        };
      }),
    );

    return { comparisons };
  }

  /** Mọi đơn tạo trong khoảng, bất kể trạng thái. */
  async getOrdersByStatus(user: AuthUser, query: StatsQueryDto) {
    const scope = orderScope(user, query.branchId);
    const { fromDate, toDate } = query.range();

    const rows = await this.prisma.order.groupBy({
      by: ['status'],
      where: {
        tenantId: user.tenantId ?? undefined,
        ...(scope.branchId ? { branchId: scope.branchId } : {}),
        createdAt: { gte: fromDate, lte: toDate },
      },
      _sum: { grandTotal: true },
      _count: { _all: true },
    });

    const statuses = rows
      .map((row) => ({
        status: row.status,
        count: row._count._all,
        total: Number(row._sum.grandTotal ?? 0),
      }))
      .sort((a, b) => b.count - a.count);
    return {
      totalCount: statuses.reduce((n, s) => n + s.count, 0),
      statuses,
    };
  }

  /** Tình trạng đơn đang chạy tại thời điểm gọi, một câu SQL. */
  async getOrderPipeline(user: AuthUser, query: OrderPipelineQueryDto) {
    const scope = orderScope(user, query.branchId);
    const rows = await this.countOpenOrders(user.tenantId, scope.branchId);

    const countOf = (statuses: readonly string[], deliveryFailed: boolean) =>
      rows
        .filter(
          (row) =>
            row.deliveryFailed === deliveryFailed &&
            statuses.includes(row.status),
        )
        .reduce((total, row) => total + row.count, 0);

    const stages: { key: string; statuses: string[]; count: number }[] =
      ORDER_PIPELINE_STAGES.map((stage) => ({
        key: stage.key,
        statuses: [...stage.statuses],
        count: countOf(stage.statuses, false),
      }));
    stages.push({
      key: DELIVERY_FAILED_STAGE,
      statuses: [OrderStatus.SHIPPING],
      count: countOf([OrderStatus.SHIPPING], true),
    });

    return { stages };
  }

  private countOpenOrders(tenantId: string | null, branchId?: string) {
    const pipelineStatuses = ORDER_PIPELINE_STAGES.flatMap((s) => s.statuses);
    return this.prisma.$queryRaw<
      { status: string; deliveryFailed: boolean; count: number }[]
    >`
      SELECT o.status AS "status",
             (o.status = ${OrderStatus.SHIPPING}
               AND EXISTS (
                 SELECT 1 FROM shipments s
                 WHERE s.tenant_id = o.tenant_id AND s.order_id = o.id
                   AND s.status = ${ShipmentStatus.FAILED})
             ) AS "deliveryFailed",
             COUNT(*)::int AS "count"
      FROM orders o
      WHERE o.tenant_id = ${tenantId}
        AND o.status IN (${Prisma.join(pipelineStatuses)})
        ${branchId ? Prisma.sql`AND o.branch_id = ${branchId}` : Prisma.empty}
      GROUP BY 1, 2
    `;
  }

  /** Hàng còn trên kệ nhưng bán ít nhất trong kỳ. */
  async getSlowProducts(user: AuthUser, query: SlowProductsQueryDto) {
    const scope = orderScope(user, query.branchId);

    const rows = await this.prisma.$queryRaw<
      {
        productItemId: string;
        productName: string;
        sku: string | null;
        shelf: number;
        quantity: Prisma.Decimal;
        revenue: Prisma.Decimal;
      }[]
    >`
      WITH stock AS (
        SELECT i.product_item_id, SUM(i.stock - i.locked_stock)::int AS shelf
        FROM inventories i
        JOIN locations l ON l.id = i.location_id
        WHERE i.tenant_id = ${user.tenantId}
          AND l.status <> ${LocationStatus.DELETED}
          ${scope.branchId ? Prisma.sql`AND i.location_id = ${scope.branchId}` : Prisma.empty}
        GROUP BY i.product_item_id
        HAVING SUM(i.stock - i.locked_stock) > 0
      ),
      sold AS (
        SELECT jl.product_item_id,
               SUM(jl.quantity) AS quantity,
               SUM(jl.amount) AS revenue
        FROM sales_journal_lines jl
        JOIN sales_journal_entries e ON e.id = jl.entry_id
        WHERE ${this.journalFilter(user.tenantId, scope.branchId, businessDatesOf(query.range()))}
        GROUP BY jl.product_item_id
      )
      SELECT s.product_item_id          AS "productItemId",
             pi.product_name            AS "productName",
             pi.sku                     AS "sku",
             s.shelf                    AS "shelf",
             COALESCE(sold.quantity, 0) AS "quantity",
             COALESCE(sold.revenue, 0)  AS "revenue"
      FROM stock s
      JOIN product_items pi ON pi.id = s.product_item_id
      LEFT JOIN sold ON sold.product_item_id = s.product_item_id
      ORDER BY COALESCE(sold.quantity, 0) ASC, s.shelf DESC, pi.product_name ASC
      LIMIT ${query.limit}
    `;

    return {
      products: rows.map((row) => ({
        productItemId: row.productItemId,
        productName: row.productName,
        sku: row.sku,
        shelf: row.shelf,
        quantity: Number(row.quantity),
        revenue: Number(row.revenue),
      })),
    };
  }

  /** Doanh thu ròng theo chi nhánh bán (`branch_id` của đơn gốc, kể cả hàng trả), từ sổ doanh thu. */
  async getRevenueByBranch(user: AuthUser, query: RevenueByBranchQueryDto) {
    const scope = orderScope(user, query.branchId);

    const rows = await this.prisma.$queryRaw<
      { branchId: string; revenue: Prisma.Decimal; orderCount: number }[]
    >`
      SELECT e.branch_id AS "branchId",
             COALESCE(SUM(e.total_amount), 0) AS "revenue",
             (COUNT(*) FILTER (WHERE e.entry_type = 'SALE'))::int AS "orderCount"
      FROM sales_journal_entries e
      WHERE ${this.journalFilter(user.tenantId, scope.branchId, businessDatesOf(query.range()))}
      GROUP BY 1
    `;
    // Branch.id = Location.id nên tên nằm ở location.
    const locations = await this.prisma.location.findMany({
      where: { id: { in: rows.map((r) => r.branchId) } },
      select: { id: true, name: true },
    });
    const nameOf = new Map(locations.map((l) => [l.id, l.name]));

    const all = rows
      .map((row) => {
        const revenue = Number(row.revenue);
        return {
          branchId: row.branchId,
          branchName: nameOf.get(row.branchId) ?? null,
          revenue,
          orderCount: row.orderCount,
          aov: averageOrderValue(revenue, row.orderCount),
        };
      })
      .sort((a, b) => b.revenue - a.revenue);

    const { rows: branches, summary, pagination } = pageOfRanking(all, query);
    return { branches, summary, pagination };
  }

  /** Doanh thu theo thứ và giờ. */
  async getSalesHeatmap(user: AuthUser, query: StatsQueryDto) {
    const scope = orderScope(user, query.branchId);

    const rows = await this.prisma.$queryRaw<
      {
        weekday: number;
        hour: number;
        revenue: Prisma.Decimal;
        orderCount: number;
      }[]
    >`
      SELECT EXTRACT(DOW  FROM e.posted_at AT TIME ZONE ${TZ_NAME})::int AS "weekday",
             EXTRACT(HOUR FROM e.posted_at AT TIME ZONE ${TZ_NAME})::int AS "hour",
             COALESCE(SUM(e.total_amount), 0) AS "revenue",
             COUNT(*)::int                    AS "orderCount"
      FROM sales_journal_entries e
      WHERE ${this.journalFilter(user.tenantId, scope.branchId, businessDatesOf(query.range()))}
        AND e.entry_type = 'SALE'
      GROUP BY 1, 2
      ORDER BY 1, 2
    `;

    return {
      cells: rows.map((r) => ({
        weekday: r.weekday,
        hour: r.hour,
        revenue: Number(r.revenue),
        orderCount: r.orderCount,
      })),
    };
  }

  /** Khách mua nhiều nhất, bỏ khách vãng lai. */
  async getTopCustomers(user: AuthUser, query: TopCustomersQueryDto) {
    const scope = orderScope(user, query.branchId);

    const rows = await this.prisma.$queryRaw<
      {
        customerId: string;
        name: string | null;
        phone: string | null;
        revenue: Prisma.Decimal;
        orderCount: number;
      }[]
    >`
      SELECT e.customer_id AS "customerId",
             MIN(c.name)   AS "name",
             MIN(c.phone)  AS "phone",
             COALESCE(SUM(e.total_amount), 0) AS "revenue",
             (COUNT(*) FILTER (WHERE e.entry_type = 'SALE'))::int AS "orderCount"
      FROM sales_journal_entries e
      JOIN customers c ON c.id = e.customer_id
      WHERE ${this.journalFilter(user.tenantId, scope.branchId, businessDatesOf(query.range()))}
        AND c.customer_code IS DISTINCT FROM 'KH_VANGLAI'
      GROUP BY e.customer_id
      ORDER BY "revenue" DESC
      LIMIT ${query.limit}
    `;

    return {
      customers: rows.map((row) => {
        const revenue = Number(row.revenue);
        return {
          customerId: row.customerId,
          name: row.name ?? null,
          phone: row.phone ?? null,
          revenue,
          orderCount: row.orderCount,
          aov: averageOrderValue(revenue, row.orderCount),
        };
      }),
    };
  }

  async getCashflow(user: AuthUser, query: CashflowQueryDto) {
    const rows = await this.prisma.cashFlow.groupBy({
      by: ['flowType'],
      where: this.cashflowWhere(user, query),
      _sum: { amount: true },
      _count: { _all: true },
    });
    // Thu chi chia theo loại và quỹ.
    const detail = await this.prisma.cashFlow.groupBy({
      by: ['fund', 'category', 'flowType'],
      where: this.cashflowWhere(user, query),
      _sum: { amount: true },
      _count: { _all: true },
    });
    const byFund = new Map<
      string,
      { fund: string; income: number; expense: number; count: number }
    >();
    for (const row of detail) {
      const entry = byFund.get(row.fund) ?? {
        fund: row.fund,
        income: 0,
        expense: 0,
        count: 0,
      };
      const amount = Number(row._sum.amount ?? 0);
      if (row.flowType === FlowType.INCOME) entry.income += amount;
      else entry.expense += amount;
      entry.count += row._count._all;
      byFund.set(row.fund, entry);
    }

    const totalOf = (flowType: string) =>
      Number(rows.find((row) => row.flowType === flowType)?._sum.amount ?? 0);
    const income = totalOf(FlowType.INCOME);
    const expense = totalOf(FlowType.EXPENSE);

    return {
      income,
      expense,
      net: income - expense,
      byType: rows.map((row) => ({
        flowType: row.flowType,
        total: Number(row._sum.amount ?? 0),
        count: row._count._all,
      })),
      byCategory: detail
        .map((row) => ({
          category: row.category,
          fund: row.fund,
          flowType: row.flowType,
          total: Number(row._sum.amount ?? 0),
          count: row._count._all,
        }))
        .sort((a, b) => b.total - a.total),
      byFund: [...byFund.values()].map((f) => ({
        ...f,
        net: f.income - f.expense,
      })),
    };
  }

  async getCashflowList(user: AuthUser, query: CashflowListQueryDto) {
    const where = this.cashflowWhere(user, query);
    const { page, limit } = query;

    const [rows, total] = await Promise.all([
      this.prisma.cashFlow.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: skipFor(page, limit),
        take: limit,
        include: {
          location: { select: { id: true, type: true, name: true } },
          supplier: { select: { supplierName: true } },
          createdBy: {
            select: { profileFirstName: true, profileLastName: true },
          },
        },
      }),
      this.prisma.cashFlow.count({ where }),
    ]);

    const data = rows.map((row) => {
      const at = withNamedPosting(row);
      return {
        id: row.id,
        flowType: row.flowType,
        amount: Number(row.amount),
        paymentMethod: row.paymentMethod,
        description: row.description,
        paymentReference: row.paymentReference,
        category: row.category,
        fund: row.fund,
        sepayLedgerId: row.sepayLedgerId,
        branchName: at.branch?.name ?? null,
        warehouseName: at.warehouse?.name ?? null,
        // Gộp chi nhánh/kho thành một cột vị trí.
        locationName: (at.branch ?? at.warehouse)?.name ?? null,
        locationType: locationRefOf(row.location)?.locationType ?? null,
        supplierName: row.supplier?.supplierName ?? null,
        createdByName: fullName(row.createdBy),
        orderId: row.orderId,
        createdAt: row.createdAt,
      };
    });

    return paginate(data, total, page, limit);
  }

  private cashflowWhere(
    user: AuthUser,
    query: CashflowQueryDto,
  ): Prisma.CashFlowWhereInput {
    const scope = locationScope(user, query.branchId, query.warehouseId);
    const { fromDate, toDate } = query.range();
    const paymentMethod = (query as CashflowListQueryDto).paymentMethod;

    return {
      tenantId: user.tenantId ?? undefined,
      ...postingWhere(scope),
      createdAt: { gte: fromDate, lte: toDate },
      ...(query.flowType ? { flowType: query.flowType } : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(query.fund ? { fund: query.fund } : {}),
      ...(paymentMethod ? { paymentMethod } : {}),
      // Lọc theo tiền tố mã chứng từ.
      ...(query.flow
        ? {
            paymentReference: {
              startsWith: query.flow,
              mode: Prisma.QueryMode.insensitive,
            },
          }
        : {}),
    };
  }

  /** Giá trị tồn và hàng sắp hết. */
  async getInventory(user: AuthUser, query: InventoryStatsQueryDto) {
    const scope = locationScope(user, query.branchId, query.warehouseId);
    const threshold = query.lowStockThreshold ?? DEFAULT_LOW_STOCK_THRESHOLD;
    const tenantId = user.tenantId ?? undefined;

    // Id chi nhánh và kho đều là Location id, nên cả hai cùng lọc trên một cột `location_id`.
    const locationId = scope.branchId ?? scope.warehouseId;
    const locationFilter = locationId
      ? Prisma.sql`AND i.location_id = ${locationId}`
      : Prisma.empty;

    const [totalRows, valueRows, lowStock] = await Promise.all([
      this.prisma.$queryRaw<
        {
          totalUnits: number;
          skuCount: number;
          outOfStock: number;
        }[]
      >`
        SELECT COALESCE(SUM(i.stock), 0)::int            AS "totalUnits",
               COUNT(*)::int                             AS "skuCount",
               COUNT(*) FILTER (WHERE i.stock <= 0)::int AS "outOfStock"
        FROM inventories i
        WHERE i.tenant_id = ${tenantId}
          ${locationFilter}
      `,
      // Giá trị tồn từ các lô, tách hàng bán được và hàng hỏng.
      this.prisma.$queryRaw<
        {
          stockValue: Prisma.Decimal;
          damagedValue: Prisma.Decimal;
          damagedUnits: number;
        }[]
      >`
        SELECT COALESCE(SUM(lot.remaining_quantity * lot.unit_cost) FILTER (WHERE lot.is_sellable), 0) AS "stockValue",
               COALESCE(SUM(lot.remaining_quantity * lot.unit_cost) FILTER (WHERE NOT lot.is_sellable), 0) AS "damagedValue",
               COALESCE(SUM(lot.remaining_quantity) FILTER (WHERE NOT lot.is_sellable), 0)::int AS "damagedUnits"
        FROM inventory_lots lot
        WHERE lot.tenant_id = ${tenantId}
          AND lot.remaining_quantity > 0
          ${locationId ? Prisma.sql`AND lot.location_id = ${locationId}` : Prisma.empty}
      `,
      this.prisma.inventory.findMany({
        where: { tenantId, ...postingWhere(scope), stock: { lte: threshold } },
        orderBy: { stock: 'asc' },
        take: LOW_STOCK_LIST_LIMIT,
        select: {
          productItemId: true,
          location: LOCATION_TYPE_SELECT,
          stock: true,
          productItem: { select: { productName: true, sku: true } },
        },
      }),
    ]);

    const totals = totalRows[0];
    return {
      stockValue: Number(valueRows[0]?.stockValue ?? 0),
      damagedValue: Number(valueRows[0]?.damagedValue ?? 0),
      damagedUnits: valueRows[0]?.damagedUnits ?? 0,
      totalUnits: totals?.totalUnits ?? 0,
      skuCount: totals?.skuCount ?? 0,
      outOfStock: totals?.outOfStock ?? 0,
      lowStockThreshold: threshold,
      lowStock: lowStock.map((row) => {
        const { branchId, warehouseId } = columnsOfLocation(row.location);
        return {
          productItemId: row.productItemId,
          productName: row.productItem.productName,
          sku: row.productItem.sku,
          // Giữ cặp branch/warehouse như dashboard đang đọc, suy ra từ Location của dòng.
          branchId,
          warehouseId,
          locationType: row.location.type, // BRANCH | WAREHOUSE, giữ nguyên như lưu trong DB
          stock: row.stock,
        };
      }),
    };
  }

  /** Cảnh báo tồn kho cho dashboard: hết, sắp hết, dưới mức tối thiểu, lâu không bán. */
  async getStockAlerts(user: AuthUser, query: StockAlertsQueryDto) {
    const scope = locationScope(user, query.branchId, query.warehouseId);
    const threshold = query.lowStockThreshold ?? DEFAULT_LOW_STOCK_THRESHOLD;
    const locationId = scope.branchId ?? scope.warehouseId;
    const warningDays = STOCK_AGING_DAYS[StockAgingLevel.WARNING];
    const attentionDays = STOCK_AGING_DAYS[StockAgingLevel.ATTENTION];
    const staleDays = STOCK_AGING_DAYS[StockAgingLevel.STALE];

    const stockRows = Prisma.sql`
      WITH stock_rows AS (
        SELECT i.id                         AS "inventoryId",
               i.product_item_id            AS "productItemId",
               pi.product_name              AS "productName",
               pi.sku                       AS "sku",
               i.location_id                AS "locationId",
               l.name                       AS "locationName",
               l.location_type              AS "locationType",
               (i.stock - i.locked_stock)::int AS "shelf",
               i.min_stock                  AS "minStock",
               CASE WHEN i.stock - i.locked_stock > 0 THEN
                 (now() AT TIME ZONE ${TZ_NAME})::date
                 - (COALESCE(
                     (SELECT MAX(t.created_at) FROM inventory_transactions t
                      WHERE t.tenant_id = i.tenant_id
                        AND t.location_id = i.location_id
                        AND t.product_item_id = i.product_item_id
                        AND t.type = ${InventoryTxType.SALE}),
                     (SELECT MIN(lot.received_at) FROM inventory_lots lot
                      WHERE lot.tenant_id = i.tenant_id
                        AND lot.location_id = i.location_id
                        AND lot.product_item_id = i.product_item_id
                        AND lot.is_sellable
                        AND lot.remaining_quantity > 0),
                     i.created_at
                   ) AT TIME ZONE ${TZ_NAME})::date
               END                          AS "daysIdle"
        FROM inventories i
        JOIN product_items pi ON pi.id = i.product_item_id
        JOIN locations l ON l.id = i.location_id
        WHERE i.tenant_id = ${user.tenantId}
          AND l.status <> ${LocationStatus.DELETED}
          ${locationId ? Prisma.sql`AND i.location_id = ${locationId}` : Prisma.empty}
      )`;

    const [countRows, listRows] = await this.prisma.$transaction(
      [
        this.prisma.$queryRaw<
          {
            outOfStock: number;
            lowStock: number;
            belowMin: number;
            warning: number;
            attention: number;
            stale: number;
          }[]
        >`
          ${stockRows}
          SELECT
            COUNT(*) FILTER (WHERE "shelf" <= 0)::int AS "outOfStock",
            COUNT(*) FILTER (WHERE "shelf" > 0 AND "shelf" <= ${threshold})::int AS "lowStock",
            COUNT(*) FILTER (WHERE "minStock" > 0 AND "shelf" <= "minStock")::int AS "belowMin",
            COUNT(*) FILTER (WHERE "daysIdle" >= ${warningDays} AND "daysIdle" < ${attentionDays})::int AS "warning",
            COUNT(*) FILTER (WHERE "daysIdle" >= ${attentionDays} AND "daysIdle" < ${staleDays})::int AS "attention",
            COUNT(*) FILTER (WHERE "daysIdle" >= ${staleDays})::int AS "stale"
          FROM stock_rows
        `,
        this.prisma.$queryRaw<StockAlertRow[]>`
          ${stockRows}
          (SELECT ${StockAlertCategory.OUT_OF_STOCK}::text AS "category", r.* FROM stock_rows r
            WHERE r."shelf" <= 0
            ORDER BY r."productName" LIMIT ${ALERT_LIST_LIMIT})
          UNION ALL
          (SELECT ${StockAlertCategory.LOW_STOCK}::text, r.* FROM stock_rows r
            WHERE r."shelf" > 0 AND r."shelf" <= ${threshold}
            ORDER BY r."shelf" ASC, r."productName" LIMIT ${ALERT_LIST_LIMIT})
          UNION ALL
          (SELECT ${StockAlertCategory.BELOW_MIN}::text, r.* FROM stock_rows r
            WHERE r."minStock" > 0 AND r."shelf" <= r."minStock"
            ORDER BY (r."minStock" - r."shelf") DESC, r."productName" LIMIT ${ALERT_LIST_LIMIT})
          UNION ALL
          (SELECT ${StockAlertCategory.AGING}::text, r.* FROM stock_rows r
            WHERE r."daysIdle" >= ${warningDays}
            ORDER BY r."daysIdle" DESC, r."productName" LIMIT ${ALERT_LIST_LIMIT})
        `,
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    const counts = countRows[0];
    const itemsOf = (category: string) =>
      listRows
        .filter((row) => row.category === category)
        .map((row) => ({
          inventoryId: row.inventoryId,
          productItemId: row.productItemId,
          productName: row.productName,
          sku: row.sku,
          locationId: row.locationId,
          locationName: row.locationName,
          locationType: row.locationType,
          shelf: row.shelf,
          minStock: row.minStock,
          daysIdle: row.daysIdle,
          agingLevel:
            row.daysIdle === null ? null : stockAgingLevel(row.daysIdle),
        }));

    return {
      lowStockThreshold: threshold,
      counts: {
        outOfStock: counts?.outOfStock ?? 0,
        lowStock: counts?.lowStock ?? 0,
        belowMin: counts?.belowMin ?? 0,
        aging: {
          warning: counts?.warning ?? 0,
          attention: counts?.attention ?? 0,
          stale: counts?.stale ?? 0,
        },
      },
      items: {
        outOfStock: itemsOf(StockAlertCategory.OUT_OF_STOCK),
        lowStock: itemsOf(StockAlertCategory.LOW_STOCK),
        belowMin: itemsOf(StockAlertCategory.BELOW_MIN),
        aging: itemsOf(StockAlertCategory.AGING),
      },
    };
  }
}
