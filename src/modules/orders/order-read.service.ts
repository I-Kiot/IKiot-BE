import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  FulfillmentType,
  RemittanceStatus,
  UNSHIPPED_ORDER_STATUSES,
} from '../../common/constants/order-status';
import { ErrorCode } from '../../common/errors/error-codes';
import type { AuthUser } from '../../common/types/auth-user.type';
import { paginate, skipFor } from '../../common/utils/pagination';
import { can } from '../../common/utils/permission';
import { narrowToScope } from '../../common/utils/scope-filter';
import type { Prisma } from '../../../generated/prisma/client';
import { QueryOrderJourneyDto } from './dto/query-order-journey.dto';
import {
  ORDER_DETAIL_INCLUDE,
  ORDER_LIST_INCLUDE,
  type OrderDetailRow,
  type OrderListRow,
} from './order-read';
import { toOrderDetail, toOrderListItem } from './order-read.mapper';
import {
  PaymentKind,
  PRIORITY_SORT_ORDER,
  type OrderSort,
} from './order-read.constants';
import {
  computeStockChecks,
  summarizeStock,
  type StockCheck,
} from './stock-check';

/** What the list query found, before it is mapped to the contract's shapes. */
export interface OrderListResult {
  rows: OrderListRow[];
  total: number;
  /** Keyed by order line id; a line missing from it has `stockCheck: null`. */
  stockChecks: Map<string, StockCheck>;
}

export interface OrderDetailResult {
  row: OrderDetailRow;
  stockChecks: Map<string, StockCheck>;
}

/** The fields the stockSummary filter sorts and checks candidates by. */
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

/**
 * `GET /orders` and `GET /orders/:id` for the order journey (A-9, contract §2).
 *
 * Kept apart from OrderService, which is the till's: the reads return a superset of what POS
 * already gets, so the till keeps working off the same two routes, and nothing in OrderService
 * had to change. The branch rule is the same as OrderService's - own branch, or every branch
 * with `orders:view_all` - and must stay so.
 */
@Injectable()
export class OrderReadService {
  constructor(private readonly prisma: PrismaService) {}

  /** `GET /orders`: `{ data: OrderListItem[], pagination }`. */
  async findAll(user: AuthUser, tenantId: string, query: QueryOrderJourneyDto) {
    const { rows, total, stockChecks } = await this.listRows(
      user,
      tenantId,
      query,
    );
    return paginate(
      rows.map((row) => toOrderListItem(row, stockChecks)),
      total,
      query.page,
      query.limit,
    );
  }

  /** `GET /orders/:id`: `OrderDetail`. */
  async findOne(user: AuthUser, tenantId: string, id: string) {
    const { row, stockChecks } = await this.findRow(user, tenantId, id);
    return toOrderDetail(row, stockChecks);
  }

  // ─── Queries ───────────────────────────────────────────────────────────────

  private async listRows(
    user: AuthUser,
    tenantId: string,
    query: QueryOrderJourneyDto,
  ): Promise<OrderListResult> {
    const where = this.listWhere(user, tenantId, query);
    if (query.stockSummary) {
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

  private async findRow(
    user: AuthUser,
    tenantId: string,
    id: string,
  ): Promise<OrderDetailResult> {
    // Another tenant's order is simply not found (contract §0); another branch's is refused, as OrderService does.
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

    const scope = this.branchScope(user);
    if (scope.branchId !== undefined && row.branchId !== scope.branchId) {
      throw new ForbiddenException({
        code: ErrorCode.ORDER_BRANCH_DENIED,
        message: 'This order does not belong to your branch',
      });
    }

    const stockChecks = await computeStockChecks(this.prisma, tenantId, [row]);
    return { row, stockChecks };
  }

  // ─── Filters ───────────────────────────────────────────────────────────────

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
    if (query.excludePos) {
      and.push({ fulfillmentType: { not: FulfillmentType.TAKEAWAY } });
    }

    // A named customer wins over a free-text search, as in OrderService: asking for both means the id is the specific thing.
    if (query.customerId) {
      and.push({ customerId: query.customerId });
    } else if (query.search) {
      const contains = { contains: query.search, mode: 'insensitive' } as const;
      and.push({
        OR: [
          { code: contains },
          { customer: { OR: [{ name: contains }, { phone: contains }] } },
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

    // stockCheck only exists until an order ships, so neither does a stockSummary to match.
    if (query.stockSummary) {
      and.push({ status: { in: [...UNSHIPPED_ORDER_STATUSES] } });
    }

    return { AND: and };
  }

  /** Same rule as OrderService.branchScope: own branch by default, every branch with `orders:view_all`. */
  private branchScope(user: AuthUser): { branchId?: string } {
    if (can(user, 'orders', 'view_all')) return {};
    if (!user.branchId) {
      throw new ForbiddenException({
        code: ErrorCode.ACCOUNT_HAS_NO_BRANCH,
        message: 'This account has not been assigned to a branch',
      });
    }
    return { branchId: user.branchId };
  }

  // ─── Paging ────────────────────────────────────────────────────────────────

  /**
   * One page sorted most urgent first. `priority` is a string column, so the database would sort
   * it alphabetically; instead each priority is its own bucket, newest first inside it, and the
   * page is cut across the buckets in turn - a count per bucket, and at most one read per bucket
   * the page actually touches.
   */
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

  /**
   * The stockSummary filter. A summary is worked out from live stock, not stored, so the database
   * cannot filter on it: every unshipped order matching the other filters is checked here, then
   * sorted and paged in memory. Bounded by the orders still waiting to leave, not by history -
   * fine at a shop's scale; if it ever is not, this is the place to precompute.
   */
  private async listByStockSummary(
    tenantId: string,
    where: Prisma.OrderWhereInput,
    query: QueryOrderJourneyDto,
  ): Promise<OrderListResult> {
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
      .filter(
        (order) =>
          summarizeStock(
            order.items.map((line) => stockChecks.get(line.id)),
          ) === query.stockSummary,
      )
      .sort(compareFor(query.sort));

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
}

/** Database sort for every `sort` but `priority` (see `pageByPriority`). */
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

/** The same three sorts, in memory, for the stockSummary filter - must agree with `orderByFor` and `pageByPriority`. */
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

/** The `cashRemittanceStatus` filter, read off the order's BALANCE payment. NOT_APPLICABLE is the absence of anything to remit: no BALANCE row, or one that never waited on a shipper. */
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
