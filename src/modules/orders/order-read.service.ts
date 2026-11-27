import { postingOf } from '../../common/utils/tenant-scope';
import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  FulfillmentType,
  OrderStatus,
  RemittanceStatus,
  UNSHIPPED_ORDER_STATUSES,
} from '../../common/constants/order-status';
import { ErrorCode } from '../../common/errors/error-codes';
import type { AuthUser } from '../../common/types/auth-user.type';
import { paginate, skipFor } from '../../common/utils/pagination';
import { can } from '../../common/utils/permission';
import { narrowToScope } from '../../common/utils/scope-filter';
import { phoneSearchTerms } from '../../common/utils/phone-search';
import type { Prisma } from '../../../generated/prisma/client';
import { businessDate } from '../cash-drawer-sessions/business-date';
import { QueryOrderJourneyDto } from './dto/query-order-journey.dto';
import {
  ORDER_DETAIL_INCLUDE,
  ORDER_LIST_INCLUDE,
  type OrderDetailRow,
  type OrderListRow,
} from './order-read';
import { toOrderDetail, toOrderListItem } from './order-read.mapper';
import {
  linkedProductionByOrderItem,
  NO_LINE_PRODUCTION,
  type OrderLineProduction,
} from '../production-requests/production-coverage';
import { productionStateForPairs } from '../production-requests/production-list.loader';
import { orderableLinesOf } from '../production-requests/production-orderable';
import {
  DUE_SOON_DAYS,
  PaymentKind,
  PRIORITY_SORT_ORDER,
  StockCheckStatus,
  type OrderSort,
} from './order-read.constants';
import {
  computeStockChecks,
  summarizeStock,
  type StockCheck,
} from './stock-check';

/** Chỉ trả `changes`/`metadata` khi là object. */
function isJsonObject(value: Prisma.JsonValue): value is Prisma.JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface OrderListResult {
  rows: OrderListRow[];
  total: number;
  stockChecks: Map<string, StockCheck>;
}

export interface OrderDetailResult {
  row: OrderDetailRow;
  stockChecks: Map<string, StockCheck>;
}

const STOCK_SUMMARY_CANDIDATE_SELECT = {
  id: true,
  status: true,
  priority: true,
  createdAt: true,
  requestedDeliveryDate: true,
  items: {
    select: {
      id: true,
      productItemId: true,
      sourceLocationId: true,
      lineType: true,
      status: true,
      quantity: true,
    },
  },
} as const satisfies Prisma.OrderSelect;

type StockSummaryCandidate = Prisma.OrderGetPayload<{
  select: typeof STOCK_SUMMARY_CANDIDATE_SELECT;
}>;

/** Đọc danh sách và chi tiết đơn hành trình. */
@Injectable()
export class OrderReadService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(user: AuthUser, tenantId: string, query: QueryOrderJourneyDto) {
    const { rows, total, stockChecks } = await this.listRows(
      user,
      tenantId,
      query,
    );
    const production = await this.lineProduction(tenantId, rows, stockChecks);
    return paginate(
      rows.map((row) => toOrderListItem(row, stockChecks, production)),
      total,
      query.page,
      query.limit,
    );
  }

  /** Đếm đơn cần chú ý cho badge, cùng quy tắc với bộ lọc `attention`. */
  async alerts(user: AuthUser, tenantId: string, branchId?: string) {
    const base = Object.assign(new QueryOrderJourneyDto(), {
      excludePos: true,
      branchId,
    });
    const shortWhere = this.listWhere(user, tenantId, {
      ...base,
      attention: 'SHORT',
    });
    const dueWhere = this.listWhere(user, tenantId, {
      ...base,
      attention: 'DUE_SOON',
    });

    const overdueWhere = this.listWhere(user, tenantId, {
      ...base,
      attention: 'PICKUP_OVERDUE',
    });

    const [candidates, dueSoon, pickupOverdue] = await Promise.all([
      this.prisma.order.findMany({
        where: shortWhere,
        select: STOCK_SUMMARY_CANDIDATE_SELECT,
      }),
      this.prisma.order.count({ where: dueWhere }),
      this.prisma.order.count({ where: overdueWhere }),
    ]);
    const stockChecks = await computeStockChecks(
      this.prisma,
      tenantId,
      candidates,
    );
    const short = candidates.filter((order) =>
      isShort(summarizeStock(order.items.map((l) => stockChecks.get(l.id)))),
    ).length;

    return { short, dueSoon, pickupOverdue, dueSoonDays: DUE_SOON_DAYS };
  }

  async findOne(user: AuthUser, tenantId: string, id: string) {
    const { row, stockChecks } = await this.findRow(user, tenantId, id);
    // `row.payments` chỉ có khoản BALANCE (cho `collection`); tóm tắt tiền cần mọi khoản.
    const payments = await this.prisma.payment.findMany({
      where: { orderId: id },
      select: {
        kind: true,
        status: true,
        amount: true,
        method: true,
        remittanceStatus: true,
      },
    });
    const journal = await this.prisma.salesJournalEntry.findMany({
      where: { orderId: id },
      select: { entryType: true },
    });
    const production = await this.lineProduction(tenantId, [row], stockChecks);
    return toOrderDetail(
      row,
      stockChecks,
      payments,
      journal.map((e) => e.entryType),
      production,
    );
  }

  /** Tiến độ sản xuất của từng dòng đơn. */
  private async lineProduction(
    tenantId: string,
    orders: readonly {
      items: readonly {
        id: string;
        productItemId: string;
        sourceLocationId: string | null;
        quantity: number;
        isCustom: boolean;
      }[];
    }[],
    stockChecks: Map<string, StockCheck>,
  ): Promise<Map<string, OrderLineProduction>> {
    const items = orders.flatMap((order) => order.items);
    const linked = await linkedProductionByOrderItem(
      this.prisma,
      tenantId,
      items.map((line) => line.id),
    );
    const candidates = items.filter((line) => stockChecks.has(line.id));
    const orderable =
      candidates.length === 0
        ? null
        : orderableLinesOf(
            candidates,
            (id) => stockChecks.get(id)?.shortQuantity ?? null,
            await productionStateForPairs(
              this.prisma,
              tenantId,
              candidates.map((line) => ({
                locationId: line.sourceLocationId,
                productItemId: line.productItemId,
              })),
            ),
          );
    const result = new Map<string, OrderLineProduction>();
    for (const line of items) {
      const own = linked.get(line.id);
      const pooled = orderable?.get(line.id);
      if (!own && !pooled) continue;
      result.set(line.id, {
        ...NO_LINE_PRODUCTION,
        ...own,
        orderableQuantity: pooled?.orderable ?? null,
        coveringRequests: pooled?.coveringRequests ?? [],
      });
    }
    return result;
  }

  private async listRows(
    user: AuthUser,
    tenantId: string,
    query: QueryOrderJourneyDto,
  ): Promise<OrderListResult> {
    const where = this.listWhere(user, tenantId, query);
    if (query.stockSummary || query.attention === 'SHORT') {
      return this.listByStockSummary(tenantId, where, query);
    }

    const skip = skipFor(query.page, query.limit);
    const [rows, total] = await Promise.all([
      query.sort === 'priority'
        ? this.pageByPriority(where, skip, query.limit)
        : this.prisma.order.findMany({
            where,
            include: ORDER_LIST_INCLUDE,
            orderBy: orderByFor(query.sort),
            skip,
            take: query.limit,
          }),
      this.prisma.order.count({ where }),
    ]);
    const stockChecks = await computeStockChecks(this.prisma, tenantId, rows);
    return { rows, total, stockChecks };
  }

  /** Nạp đơn và kiểm phạm vi chi nhánh. */
  private async assertVisible(user: AuthUser, tenantId: string, id: string) {
    const order = await this.prisma.order.findFirst({
      where: { id, tenantId },
      select: { id: true, branchId: true },
    });
    if (!order) {
      throw new NotFoundException({
        code: ErrorCode.ORDER_NOT_FOUND,
        message: 'Order not found',
      });
    }

    const scope = this.branchScope(user);
    if (scope.branchId !== undefined && order.branchId !== scope.branchId) {
      throw new ForbiddenException({
        code: ErrorCode.ORDER_BRANCH_DENIED,
        message: 'This order does not belong to your branch',
      });
    }
  }

  /** Nhật ký thao tác của đơn, cũ nhất trước. */
  async events(user: AuthUser, tenantId: string, id: string) {
    await this.assertVisible(user, tenantId, id);
    const rows = await this.prisma.orderEvent.findMany({
      where: { tenantId, orderId: id },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        type: true,
        fromStatus: true,
        toStatus: true,
        source: true,
        actorId: true,
        actorName: true,
        actorRole: true,
        changes: true,
        metadata: true,
        occurredAt: true,
      },
    });
    return rows.map((row) => ({
      ...row,
      changes: isJsonObject(row.changes) ? row.changes : null,
      metadata: isJsonObject(row.metadata) ? row.metadata : null,
    }));
  }

  private async findRow(
    user: AuthUser,
    tenantId: string,
    id: string,
  ): Promise<OrderDetailResult> {
    await this.assertVisible(user, tenantId, id);
    const row = await this.prisma.order.findFirst({
      where: { id, tenantId },
      include: ORDER_DETAIL_INCLUDE,
    });
    if (!row) {
      throw new NotFoundException({
        code: ErrorCode.ORDER_NOT_FOUND,
        message: 'Order not found',
      });
    }

    const stockChecks = await computeStockChecks(this.prisma, tenantId, [row]);
    return { row, stockChecks };
  }

  private listWhere(
    user: AuthUser,
    tenantId: string,
    query: QueryOrderJourneyDto,
  ): Prisma.OrderWhereInput {
    const scope = this.branchScope(user);
    const and: Prisma.OrderWhereInput[] = [{ tenantId, ...scope }];

    const branchId = narrowToScope(
      scope.branchId,
      query.branchId,
      'You can only view orders for your own branch',
    );
    if (branchId) and.push({ branchId });

    if (query.status) and.push({ status: query.status });
    if (query.paymentMethod) and.push({ paymentMethod: query.paymentMethod });
    if (query.channel) and.push({ channel: query.channel });
    if (query.assigneeId) and.push({ assigneeId: query.assigneeId });
    if (query.priority) and.push({ priority: query.priority });
    if (query.fulfillmentType) {
      and.push({ fulfillmentType: query.fulfillmentType });
    }
    if (query.excludePos) {
      and.push({ fulfillmentType: { not: FulfillmentType.TAKEAWAY } });
    }

    // Lọc theo khách có tên thắng tìm tự do, như OrderService: gửi cả hai thì mã khách là điều cụ thể hơn.
    if (query.customerId) {
      and.push({ customerId: query.customerId });
    } else if (query.search) {
      const contains = { contains: query.search, mode: 'insensitive' } as const;
      and.push({
        OR: [
          { code: contains },
          { customer: { OR: [{ name: contains }, { phone: contains }] } },
          // `Customer.phone` chỉ còn chữ số: số gõ có dấu cách, dấu chấm hay +84 phải đổi về dạng đó mới khớp.
          ...phoneSearchTerms(query.search).map((term) => ({
            customer: { phone: { contains: term } },
          })),
        ],
      });
    }

    const from = query.from ?? query.fromDate;
    const to = query.to ?? query.toDate;
    if (from || to) {
      and.push({
        createdAt: {
          ...(from ? { gte: new Date(from) } : {}),
          ...(to ? { lte: new Date(to) } : {}),
        },
      });
    }

    if (query.cashRemittanceStatus) {
      and.push(remittanceWhere(query.cashRemittanceStatus));
    }

    // Đơn đã giao thì không còn stockCheck hay attention.
    if (query.stockSummary || query.attention) {
      and.push({ status: { in: [...UNSHIPPED_ORDER_STATUSES] } });
    }

    // Đếm ngày giữa các nửa đêm giờ địa phương (cột là `date`, tức một ngày lịch).
    if (query.attention === 'DUE_SOON') {
      const cutoff = businessDate();
      cutoff.setUTCDate(cutoff.getUTCDate() + DUE_SOON_DAYS);
      and.push({ requestedDeliveryDate: { not: null, lte: cutoff } });
      // Đơn khách quá hạn lấy đã có nhóm riêng; đếm ở cả hai thì badge cộng hai lần.
      and.push({ NOT: pickupOverdueWhere() });
    }

    // Khách hẹn lấy hàng nhưng quá hạn mà vẫn chưa tới: nhân viên cần liên hệ. Chỉ đánh cờ, không tự huỷ.
    if (query.attention === 'PICKUP_OVERDUE') {
      and.push(pickupOverdueWhere());
    }

    return { AND: and };
  }

  private branchScope(user: AuthUser): { branchId?: string } {
    if (can(user, 'orders', 'view_all')) return {};
    const posting = postingOf(user);
    if (!posting) {
      throw new ForbiddenException({
        code: ErrorCode.ACCOUNT_HAS_NO_BRANCH,
        message: 'This account has not been assigned to a branch',
      });
    }
    return { branchId: posting };
  }

  /** Phân trang theo độ gấp, đọc từng nhóm ưu tiên. */
  private async pageByPriority(
    where: Prisma.OrderWhereInput,
    skip: number,
    take: number,
  ): Promise<OrderListRow[]> {
    const rows: OrderListRow[] = [];
    for (const priority of PRIORITY_SORT_ORDER) {
      if (take <= 0) break;
      const bucket: Prisma.OrderWhereInput = { AND: [where, { priority }] };
      const count = await this.prisma.order.count({ where: bucket });
      if (skip >= count) {
        skip -= count;
        continue;
      }
      const page = await this.prisma.order.findMany({
        where: bucket,
        include: ORDER_LIST_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      });
      rows.push(...page);
      take -= page.length;
      skip = 0;
    }
    return rows;
  }

  /** Lọc theo stockSummary trong bộ nhớ vì DB không lọc được. */
  private async listByStockSummary(
    tenantId: string,
    where: Prisma.OrderWhereInput,
    query: QueryOrderJourneyDto,
  ): Promise<OrderListResult> {
    const { matched, stockChecks } = await this.matchStockSummary(
      tenantId,
      where,
      query,
    );

    const skip = skipFor(query.page, query.limit);
    const pageIds = matched.slice(skip, skip + query.limit).map((o) => o.id);
    const found = await this.prisma.order.findMany({
      where: { id: { in: pageIds } },
      include: ORDER_LIST_INCLUDE,
    });
    const byId = new Map(found.map((row) => [row.id, row]));
    const rows = pageIds
      .map((id) => byId.get(id))
      .filter((row): row is OrderListRow => !!row);

    return { rows, total: matched.length, stockChecks };
  }

  /** Đơn khớp `stockSummary` / `attention=SHORT`, đã sắp theo `sort`. */
  private async matchStockSummary(
    tenantId: string,
    where: Prisma.OrderWhereInput,
    query: QueryOrderJourneyDto,
  ) {
    const candidates = await this.prisma.order.findMany({
      where,
      select: STOCK_SUMMARY_CANDIDATE_SELECT,
    });
    const stockChecks = await computeStockChecks(
      this.prisma,
      tenantId,
      candidates,
    );
    const matched = candidates
      .filter((order) => {
        const summary = summarizeStock(
          order.items.map((line) => stockChecks.get(line.id)),
        );
        if (query.stockSummary && summary !== query.stockSummary) return false;
        return query.attention !== 'SHORT' || isShort(summary);
      })
      .sort(compareFor(query.sort));
    return { matched, stockChecks };
  }

  /** Id mọi đơn khớp bộ lọc của danh sách, đúng thứ tự đang hiện, bỏ phân trang (xuất file); `ids` thu hẹp về các đơn đã tích. */
  async matchingIds(
    user: AuthUser,
    tenantId: string,
    query: QueryOrderJourneyDto,
    ids?: string[],
  ): Promise<string[]> {
    const filter = this.listWhere(user, tenantId, query);
    const where: Prisma.OrderWhereInput = ids
      ? { AND: [filter, { id: { in: ids } }] }
      : filter;
    if (query.stockSummary || query.attention === 'SHORT') {
      const { matched } = await this.matchStockSummary(tenantId, where, query);
      return matched.map((order) => order.id);
    }
    if (query.sort === 'priority') {
      const result: string[] = [];
      for (const priority of PRIORITY_SORT_ORDER) {
        const rows = await this.prisma.order.findMany({
          where: { AND: [where, { priority }] },
          select: { id: true },
          orderBy: { createdAt: 'desc' },
        });
        result.push(...rows.map((row) => row.id));
      }
      return result;
    }
    const rows = await this.prisma.order.findMany({
      where,
      select: { id: true },
      orderBy: orderByFor(query.sort),
    });
    return rows.map((row) => row.id);
  }
}

/** Lọc đơn khách tới lấy đã quá hạn. */
function pickupOverdueWhere(): Prisma.OrderWhereInput {
  return {
    fulfillmentType: FulfillmentType.STORE_PICKUP,
    status: OrderStatus.PACKED,
    requestedDeliveryDate: { not: null, lt: businessDate() },
  };
}

function isShort(summary: string | null | undefined): boolean {
  return (
    summary === StockCheckStatus.PARTIAL || summary === StockCheckStatus.OUT
  );
}

function orderByFor(
  sort: OrderSort | undefined,
): Prisma.OrderOrderByWithRelationInput[] {
  if (sort === 'requestedDeliveryDate') {
    return [
      { requestedDeliveryDate: { sort: 'asc', nulls: 'last' } },
      { createdAt: 'desc' },
    ];
  }
  return [{ createdAt: 'desc' }];
}

/** Sắp xếp trong bộ nhớ, khớp với `orderByFor` và `pageByPriority`. */
function compareFor(
  sort: OrderSort | undefined,
): (a: StockSummaryCandidate, b: StockSummaryCandidate) => number {
  const newestFirst = (a: StockSummaryCandidate, b: StockSummaryCandidate) =>
    b.createdAt.getTime() - a.createdAt.getTime();

  if (sort === 'priority') {
    const rank = (p: string) => {
      const i = PRIORITY_SORT_ORDER.indexOf(p);
      return i === -1 ? PRIORITY_SORT_ORDER.length : i;
    };
    return (a, b) => rank(a.priority) - rank(b.priority) || newestFirst(a, b);
  }
  if (sort === 'requestedDeliveryDate') {
    return (a, b) => {
      const da = a.requestedDeliveryDate?.getTime() ?? Infinity;
      const db = b.requestedDeliveryDate?.getTime() ?? Infinity;
      return da === db ? newestFirst(a, b) : da - db;
    };
  }
  return newestFirst;
}

/** Lọc theo trạng thái nộp tiền shipper. */
function remittanceWhere(status: string): Prisma.OrderWhereInput {
  if (status === RemittanceStatus.NOT_APPLICABLE) {
    return {
      payments: {
        none: {
          kind: PaymentKind.BALANCE,
          remittanceStatus: {
            in: [RemittanceStatus.PENDING, RemittanceStatus.RECEIVED],
          },
        },
      },
    };
  }
  return {
    payments: {
      some: { kind: PaymentKind.BALANCE, remittanceStatus: status },
    },
  };
}
