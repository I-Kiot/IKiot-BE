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
  changePct,
  comparisonWindows,
  exceedsHourlyRange,
  previousPeriod,
  stockAgingLevel,
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

/** `COUNT(*)` is `bigint` in Postgres; every count below is cast `::int` at the source. */
interface SummaryRow {
  revenue: Prisma.Decimal;
  shippingFee: Prisma.Decimal;
  channelFee: Prisma.Decimal;
  orderCount: number;
  customerCount: number;
}

interface CostRow {
  costOfGoods: Prisma.Decimal;
  linesMissingCost: number;
}

/** Một dòng tồn trong danh sách cảnh báo. `shelf` là tồn trên kệ (stock − locked_stock), con số bán được. */
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
  orderCount: number;
}

/** The same first+last shape `JwtStrategy` and `NotificationService.displayName` build, and `null` when there is no name on file - the old `$lookup` projected null there too. */
function fullName(
  user: {
    profileFirstName: string | null;
    profileLastName: string | null;
  } | null,
): string | null {
  if (!user?.profileFirstName) return null;
  return `${user.profileFirstName} ${user.profileLastName ?? ''}`.trim();
}

/** Ported from `StatsService.js` - the shop-facing dashboard, eight endpoints at the old paths. Three answers stay raw SQL because Prisma cannot express them (local-day bucketing, line revenue across order lines, stock valued across a join) and doing them in JavaScript would mean pulling every order line into memory. Every raw query interpolates through tagged-template parameters; the one exception is `getTopProducts`' ORDER BY column, which Postgres won't take as a bind parameter and is chosen from a two-value whitelist. */
@Injectable()
export class StatsService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── Orders ────────────────────────────────────────────────────────────────

  /** Headline KPIs with period-over-period change. `customerCount` counts distinct `customer_id`, and every walk-in points at the tenant's single `KH_VANGLAI` row, so all anonymous sales count as one - the old aggregation arrived at the same +1, so the dashboard number is unchanged by the port. */
  async getOverview(user: AuthUser, query: StatsQueryDto) {
    const scope = orderScope(user, query.branchId);
    const range = query.range();
    const previous = previousPeriod(range);

    const [current, before] = await Promise.all([
      this.summarize(user, scope, range),
      this.summarize(user, scope, previous),
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
      period: range,
      previousPeriod: previous,
    };
  }

  private async summarize(
    user: AuthUser,
    scope: { branchId?: string; impossible?: true },
    { fromDate, toDate }: DateRange,
  ) {
    if (scope.impossible) {
      return {
        revenue: 0,
        orderCount: 0,
        customerCount: 0,
        aov: 0,
        grossProfit: 0,
        linesMissingCost: 0,
      };
    }
    const branchFilter = scope.branchId
      ? Prisma.sql`AND o.branch_id = ${scope.branchId}`
      : Prisma.empty;

    const [rows, costRows] = await Promise.all([
      this.prisma.$queryRaw<SummaryRow[]>`
        SELECT COALESCE(SUM(o.grand_total), 0)  AS "revenue",
               COALESCE(SUM(o.shipping_fee), 0) AS "shippingFee",
               COALESCE(SUM(o.channel_fee), 0)  AS "channelFee",
               COUNT(*)::int                    AS "orderCount",
               COUNT(DISTINCT o.customer_id)::int AS "customerCount"
        FROM orders o
        WHERE o.tenant_id = ${user.tenantId}
          AND o.status = ${REVENUE_STATUS}
          AND o.created_at >= ${fromDate}
          AND o.created_at <= ${toDate}
          ${branchFilter}
      `,
      // Giá vốn chỉ nằm trên dòng giữ hàng (PRODUCT, món trong combo): dòng COMBO cha và SERVICE không trừ kho nên không có giá vốn, và không bị tính là "thiếu".
      this.prisma.$queryRaw<CostRow[]>`
        SELECT COALESCE(SUM(oi.unit_cost_price * oi.quantity), 0) AS "costOfGoods",
               COUNT(*) FILTER (WHERE oi.unit_cost_price IS NULL)::int AS "linesMissingCost"
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        WHERE o.tenant_id = ${user.tenantId}
          AND o.status = ${REVENUE_STATUS}
          AND o.created_at >= ${fromDate}
          AND o.created_at <= ${toDate}
          AND oi.line_type IN (${Prisma.join([...STOCKED_LINE_TYPES])})
          ${branchFilter}
      `,
    ]);
    const row = rows[0];
    const revenue = Number(row?.revenue ?? 0);
    const orderCount = row?.orderCount ?? 0;
    return {
      revenue,
      orderCount,
      customerCount: row?.customerCount ?? 0,
      aov: averageOrderValue(revenue, orderCount),
      // Lợi nhuận gộp = doanh thu − phí ship thu hộ − phí sàn − giá vốn. Phí ship khách trả là tiền đi qua tay shop để trả đơn vị vận chuyển, không phải lãi; phí sàn là phần Shopee giữ lại. Chỉ là ước tính: dòng chưa có giá vốn (`linesMissingCost`) bị tính giá vốn 0, nên FE phải nói rõ khi số này > 0.
      grossProfit:
        revenue -
        Number(row?.shippingFee ?? 0) -
        Number(row?.channelFee ?? 0) -
        Number(costRows[0]?.costOfGoods ?? 0),
      linesMissingCost: costRows[0]?.linesMissingCost ?? 0,
    };
  }

  /** Revenue over time, bucketed in the shop's local day or month: an order rung up at 23:30 belongs to that day's takings, and grouping on the raw UTC timestamp would file it under the next. */
  async getRevenueSeries(user: AuthUser, query: RevenueSeriesQueryDto) {
    const scope = orderScope(user, query.branchId);
    const range = query.range();
    const { fromDate, toDate } = range;
    const groupBy = query.groupBy ?? GroupBy.DAY;

    if (groupBy === GroupBy.HOUR && exceedsHourlyRange(range)) {
      throw new BadRequestException({
        code: ErrorCode.STATS_HOURLY_RANGE_TOO_LONG,
        message: `Hourly buckets cover at most ${MAX_HOURLY_RANGE_DAYS} days`,
      });
    }

    if (scope.impossible) return { groupBy, series: [] };

    const rows = await this.prisma.$queryRaw<BucketRow[]>`
      SELECT to_char(created_at AT TIME ZONE ${TZ_NAME}, ${BUCKET_FORMAT[groupBy]}) AS "bucket",
             COALESCE(SUM(grand_total), 0) AS "revenue",
             COUNT(*)::int                 AS "orderCount"
      FROM orders
      WHERE tenant_id = ${user.tenantId}
        AND status = ${REVENUE_STATUS}
        AND created_at >= ${fromDate}
        AND created_at <= ${toDate}
        ${scope.branchId ? Prisma.sql`AND branch_id = ${scope.branchId}` : Prisma.empty}
      GROUP BY 1
      ORDER BY 1
    `;

    return {
      groupBy,
      series: rows.map((row) => ({
        bucket: row.bucket,
        revenue: Number(row.revenue),
        orderCount: row.orderCount,
      })),
    };
  }

  async getRevenueByPaymentMethod(user: AuthUser, query: StatsQueryDto) {
    const scope = orderScope(user, query.branchId);
    if (scope.impossible) return { breakdown: [] };

    const rows = await this.prisma.order.groupBy({
      by: ['paymentMethod'],
      where: this.orderWhere(user, scope, query.range()),
      _sum: { grandTotal: true },
      _count: { _all: true },
    });

    return {
      breakdown: rows
        .map((row) => ({
          paymentMethod: row.paymentMethod,
          revenue: Number(row._sum.grandTotal ?? 0),
          orderCount: row._count._all,
        }))
        .sort((a, b) => b.revenue - a.revenue),
    };
  }

  /** Revenue attributed to whoever rang the sale up. Two queries rather than the old `$lookup`: a join would repeat every user row across all their orders just to read one name back. */
  async getRevenueByStaff(user: AuthUser, query: StatsQueryDto) {
    const scope = orderScope(user, query.branchId);
    if (scope.impossible) return { staff: [] };

    const rows = await this.prisma.order.groupBy({
      by: ['userId'],
      where: this.orderWhere(user, scope, query.range()),
      _sum: { grandTotal: true },
      _count: { _all: true },
    });

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

    return {
      staff: rows
        .map((row) => {
          const revenue = Number(row._sum.grandTotal ?? 0);
          const orderCount = row._count._all;
          return {
            userId: row.userId,
            // A channel-synced order has no creator, so its revenue is attributed to nobody.
            staffName: row.userId ? (nameOf.get(row.userId) ?? null) : null,
            revenue,
            orderCount,
            aov: averageOrderValue(revenue, orderCount),
          };
        })
        .sort((a, b) => b.revenue - a.revenue),
    };
  }

  /** Best sellers. Line revenue is `unitPrice × quantity − discountAmount`, so an order-level discount never allocated to a line is invisible here, exactly as in the old pipeline. */
  async getTopProducts(user: AuthUser, query: TopProductsQueryDto) {
    const scope = orderScope(user, query.branchId);
    const sortBy =
      query.sortBy === TopProductsSort.REVENUE
        ? TopProductsSort.REVENUE
        : TopProductsSort.QUANTITY;

    if (scope.impossible) return { sortBy, products: [] };

    const { fromDate, toDate } = query.range();
    // Not a bind parameter - Postgres will not take one in ORDER BY. Safe because it is one of exactly two literals chosen above, never a value from the query string.
    const orderColumn = Prisma.raw(`"${sortBy}"`);

    const rows = await this.prisma.$queryRaw<
      {
        productItemId: string;
        productName: string | null;
        quantity: Prisma.Decimal;
        revenue: Prisma.Decimal;
      }[]
    >`
      SELECT oi.product_item_id AS "productItemId",
             MIN(oi.product_name) AS "productName",
             COALESCE(SUM(oi.quantity), 0) AS "quantity",
             COALESCE(SUM(oi.unit_price * oi.quantity - oi.discount_amount), 0) AS "revenue"
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE o.tenant_id = ${user.tenantId}
        AND o.status = ${REVENUE_STATUS}
        AND o.created_at >= ${fromDate}
        AND o.created_at <= ${toDate}
        ${scope.branchId ? Prisma.sql`AND o.branch_id = ${scope.branchId}` : Prisma.empty}
      GROUP BY oi.product_item_id
      ORDER BY ${orderColumn} DESC
      LIMIT ${query.limit}
    `;

    return {
      sortBy,
      products: rows.map((row) => ({
        productItemId: row.productItemId,
        // The old pipeline took `$first`, i.e. whichever line came back first; MIN is the same idea made deterministic. The name is denormalized per line, so it can differ if the product was renamed mid-period.
        productName: row.productName,
        quantity: Number(row.quantity),
        revenue: Number(row.revenue),
      })),
    };
  }

  /** The five calendar milestones in one answer. Each previous window covers the same elapsed span of the period before, so a month half over is judged against half a month. */
  async getRevenueComparison(user: AuthUser, query: RevenueComparisonQueryDto) {
    const scope = orderScope(user, query.branchId);
    const windows = comparisonWindows(new Date());

    const sum = async (range: DateRange) => {
      if (scope.impossible) {
        return { ...range, revenue: 0, orderCount: 0, aov: 0 };
      }
      const agg = await this.prisma.order.aggregate({
        where: this.orderWhere(user, scope, range),
        _sum: { grandTotal: true },
        _count: { _all: true },
      });
      const revenue = Number(agg._sum.grandTotal ?? 0);
      const orderCount = agg._count._all;
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

  /** Every order created in the range whatever its status - the funnel and the cancel rate need the ones revenue leaves out. */
  async getOrdersByStatus(user: AuthUser, query: StatsQueryDto) {
    const scope = orderScope(user, query.branchId);
    if (scope.impossible) return { totalCount: 0, statuses: [] };
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

  /**
   * Tình trạng đơn đang chạy, đếm tại thời điểm gọi chứ không theo kỳ: một đơn chờ xác nhận từ
   * tuần trước vẫn là việc phải làm hôm nay, nên `orders-by-status` (lọc theo ngày tạo) không trả
   * lời được câu này. Các nhóm chia hết cho nhau - một đơn chỉ nằm ở đúng một nhóm:
   * "giao thất bại" là đơn còn SHIPPING có chuyến giao đang ở FAILED, và nó được trừ khỏi "đang giao".
   * Từ PR #39 (2026-10-19) FAILED không còn là trạng thái cuối: hàng vẫn ở chỗ shipper, giao lại
   * trên chính chuyến đó (→ DELIVERED) hoặc xác nhận hàng đã về (→ RETURNED, đơn → RETURNED) -
   * cả hai đều tự đưa đơn ra khỏi nhóm này. Mỗi đơn chỉ có một chuyến mở, nên "có chuyến FAILED"
   * là đủ, không cần xét chuyến nào mới hơn.
   * Một câu SQL duy nhất, nên các con số là cùng một thời điểm.
   */
  async getOrderPipeline(user: AuthUser, query: OrderPipelineQueryDto) {
    const scope = orderScope(user, query.branchId);
    const rows = scope.impossible
      ? []
      : await this.countOpenOrders(user.tenantId, scope.branchId);

    // Cộng số đơn của những trạng thái thuộc một nhóm, tách riêng đơn giao thất bại.
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

  /** Đếm đơn đang chạy theo trạng thái, kèm cờ "đang có chuyến giao thất bại chờ xử lý". */
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

  /**
   * Hàng bán chậm: SKU còn trên kệ nhưng bán ít nhất trong kỳ (kể cả không bán cái nào), để biết
   * nên dừng nhập gì. Tồn tính ở chi nhánh của người xem nếu họ được gắn vào một chi nhánh, còn
   * chủ shop thì cả chuỗi - trừ kho hàng hỏng (`is_sellable = false`), vì hàng ở đó vốn không để bán.
   */
  async getSlowProducts(user: AuthUser, query: SlowProductsQueryDto) {
    const scope = orderScope(user, query.branchId);
    if (scope.impossible) return { products: [] };
    const { fromDate, toDate } = query.range();

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
          AND l.is_sellable = true
          AND l.status <> ${LocationStatus.DELETED}
          ${scope.branchId ? Prisma.sql`AND i.location_id = ${scope.branchId}` : Prisma.empty}
        GROUP BY i.product_item_id
        HAVING SUM(i.stock - i.locked_stock) > 0
      ),
      sold AS (
        SELECT oi.product_item_id,
               SUM(oi.quantity) AS quantity,
               SUM(oi.unit_price * oi.quantity - oi.discount_amount) AS revenue
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        WHERE o.tenant_id = ${user.tenantId}
          AND o.status = ${REVENUE_STATUS}
          AND o.created_at >= ${fromDate}
          AND o.created_at <= ${toDate}
          ${scope.branchId ? Prisma.sql`AND o.branch_id = ${scope.branchId}` : Prisma.empty}
        GROUP BY oi.product_item_id
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

  async getRevenueByBranch(user: AuthUser, query: StatsQueryDto) {
    const scope = orderScope(user, query.branchId);
    if (scope.impossible) return { branches: [] };

    const rows = await this.prisma.order.groupBy({
      by: ['branchId'],
      where: this.orderWhere(user, scope, query.range()),
      _sum: { grandTotal: true },
      _count: { _all: true },
    });
    // Branch.id = Location.id, so the name lives on the location.
    const locations = await this.prisma.location.findMany({
      where: { id: { in: rows.map((r) => r.branchId) } },
      select: { id: true, name: true },
    });
    const nameOf = new Map(locations.map((l) => [l.id, l.name]));

    return {
      branches: rows
        .map((row) => {
          const revenue = Number(row._sum.grandTotal ?? 0);
          const orderCount = row._count._all;
          return {
            branchId: row.branchId,
            branchName: nameOf.get(row.branchId) ?? null,
            revenue,
            orderCount,
            aov: averageOrderValue(revenue, orderCount),
          };
        })
        .sort((a, b) => b.revenue - a.revenue),
    };
  }

  /** Sparse cells (only weekday/hour pairs that have sales); `weekday` is 0 = Sunday .. 6, `hour` 0-23, both in the shop's local time. */
  async getSalesHeatmap(user: AuthUser, query: StatsQueryDto) {
    const scope = orderScope(user, query.branchId);
    if (scope.impossible) return { cells: [] };
    const { fromDate, toDate } = query.range();

    const rows = await this.prisma.$queryRaw<
      {
        weekday: number;
        hour: number;
        revenue: Prisma.Decimal;
        orderCount: number;
      }[]
    >`
      SELECT EXTRACT(DOW  FROM created_at AT TIME ZONE ${TZ_NAME})::int AS "weekday",
             EXTRACT(HOUR FROM created_at AT TIME ZONE ${TZ_NAME})::int AS "hour",
             COALESCE(SUM(grand_total), 0) AS "revenue",
             COUNT(*)::int                 AS "orderCount"
      FROM orders
      WHERE tenant_id = ${user.tenantId}
        AND status = ${REVENUE_STATUS}
        AND created_at >= ${fromDate}
        AND created_at <= ${toDate}
        ${scope.branchId ? Prisma.sql`AND branch_id = ${scope.branchId}` : Prisma.empty}
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

  /** Named customers only: the tenant's `KH_VANGLAI` walk-in row aggregates every anonymous sale and would top any list. */
  async getTopCustomers(user: AuthUser, query: TopCustomersQueryDto) {
    const scope = orderScope(user, query.branchId);
    if (scope.impossible) return { customers: [] };

    const rows = await this.prisma.order.groupBy({
      by: ['customerId'],
      where: {
        ...this.orderWhere(user, scope, query.range()),
        customer: { customerCode: { not: 'KH_VANGLAI' } },
      },
      _sum: { grandTotal: true },
      _count: { _all: true },
      orderBy: { _sum: { grandTotal: 'desc' } },
      take: query.limit,
    });
    const customers = await this.prisma.customer.findMany({
      where: { id: { in: rows.map((r) => r.customerId) } },
      select: { id: true, name: true, phone: true },
    });
    const byId = new Map(customers.map((c) => [c.id, c]));

    return {
      customers: rows.map((row) => {
        const revenue = Number(row._sum.grandTotal ?? 0);
        const orderCount = row._count._all;
        const c = byId.get(row.customerId);
        return {
          customerId: row.customerId,
          name: c?.name ?? null,
          phone: c?.phone ?? null,
          revenue,
          orderCount,
          aov: averageOrderValue(revenue, orderCount),
        };
      }),
    };
  }

  private orderWhere(
    user: AuthUser,
    scope: { branchId?: string },
    { fromDate, toDate }: DateRange,
  ): Prisma.OrderWhereInput {
    return {
      tenantId: user.tenantId ?? undefined,
      status: REVENUE_STATUS,
      ...(scope.branchId ? { branchId: scope.branchId } : {}),
      createdAt: { gte: fromDate, lte: toDate },
    };
  }

  // ─── Cash flow ─────────────────────────────────────────────────────────────

  /** Income vs expense over the range, optionally narrowed to one money-flow. */
  async getCashflow(user: AuthUser, query: CashflowQueryDto) {
    const rows = await this.prisma.cashFlow.groupBy({
      by: ['flowType'],
      where: this.cashflowWhere(user, query),
      _sum: { amount: true },
      _count: { _all: true },
    });

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
    };
  }

  /** The same rows, one by one, with the names behind each foreign key resolved. */
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
        branchName: at.branch?.name ?? null,
        warehouseName: at.warehouse?.name ?? null,
        // Flattened for the table, which has one "location" column and doesn't care which kind it is - `locationType` is kept so a row can still be traced back.
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
      ...(paymentMethod ? { paymentMethod } : {}),
      // `flow` picks a money-flow by its reference-code prefix (ORD sales, SUP supplier payments); `startsWith` with an insensitive mode is the old anchored regex expressed so an index can still serve it.
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

  // ─── Inventory ─────────────────────────────────────────────────────────────

  /** Stock valuation and what is running out, for one location or the whole tenant. `lowStockThreshold` is a flat number from the query string, deliberately not the per-row `Inventory.minStock` the alerting engine uses: one says "this item needs reordering", the other is a slider on the dashboard. */
  async getInventory(user: AuthUser, query: InventoryStatsQueryDto) {
    const scope = locationScope(user, query.branchId, query.warehouseId);
    const threshold = query.lowStockThreshold ?? DEFAULT_LOW_STOCK_THRESHOLD;
    const tenantId = user.tenantId ?? undefined;

    // Branch and warehouse ids are Location ids, so either narrows the one `location_id` column.
    const locationId = scope.branchId ?? scope.warehouseId;
    const locationFilter = locationId
      ? Prisma.sql`AND i.location_id = ${locationId}`
      : Prisma.empty;

    const [totalRows, lowStock] = await Promise.all([
      this.prisma.$queryRaw<
        {
          stockValue: Prisma.Decimal;
          totalUnits: number;
          skuCount: number;
          outOfStock: number;
        }[]
      >`
        SELECT COALESCE(SUM(i.stock * pi.cost_price), 0) AS "stockValue",
               COALESCE(SUM(i.stock), 0)::int            AS "totalUnits",
               COUNT(*)::int                             AS "skuCount",
               COUNT(*) FILTER (WHERE i.stock <= 0)::int AS "outOfStock"
        FROM inventories i
        JOIN product_items pi ON pi.id = i.product_item_id
        WHERE i.tenant_id = ${tenantId}
          ${locationFilter}
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
      stockValue: Number(totals?.stockValue ?? 0),
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
          // Kept as the branch/warehouse pair the dashboard reads, derived from the row's Location.
          branchId,
          warehouseId,
          locationType: row.location.type, // BRANCH | WAREHOUSE, as stored (the one spelling, plan 2026-09-29)
          stock: row.stock,
        };
      }),
    };
  }

  /**
   * Cảnh báo tồn kho cho dashboard: hết hàng, sắp hết (theo ngưỡng trên dashboard), dưới mức tối
   * thiểu (theo `Inventory.minStock` của từng dòng - cùng quy tắc `<=` với cảnh báo low-stock) và
   * hàng lâu không bán (30 / 60 / 90 ngày, xem `stockAgingLevel`). Mọi con số đọc trên kệ
   * (stock − locked_stock): hàng đã đóng gói cho đơn không bán được nữa.
   *
   * "Số ngày không bán" tính từ lần bán cuối (sổ kho SALE) tại đúng địa điểm đó; SKU chưa bán lần
   * nào thì tính từ lô cũ nhất còn hàng, rồi mới tới ngày tạo dòng tồn. Đếm giữa hai nửa đêm giờ
   * Việt Nam, không chia mili-giây, để con số không phụ thuộc giờ gọi.
   *
   * Hai câu (đếm và danh sách) chạy trong một transaction REPEATABLE READ, nên số đếm và danh sách
   * nhìn cùng một ảnh dữ liệu - một đơn chốt giữa hai câu không làm chúng lệch nhau.
   */
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
                        AND lot.remaining_quantity > 0),
                     i.created_at
                   ) AT TIME ZONE ${TZ_NAME})::date
               END                          AS "daysIdle"
        FROM inventories i
        JOIN product_items pi ON pi.id = i.product_item_id
        JOIN locations l ON l.id = i.location_id
        WHERE i.tenant_id = ${user.tenantId}
          AND l.is_sellable = true
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
