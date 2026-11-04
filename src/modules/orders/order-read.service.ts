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

/**
 * `GET /orders` và `GET /orders/:id` của hành trình đơn (A-9). Tách khỏi OrderService (của quầy) để quầy vẫn chạy trên hai route này mà không phải đổi. Quy tắc chi nhánh giống OrderService (chi nhánh của mình, hoặc mọi chi nhánh với `orders:view_all`) và phải giữ như vậy.
 */
@Injectable()
export class OrderReadService {
  constructor(private readonly prisma: PrismaService) {}

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

  /**
   * `GET /orders/alerts`: số đơn chưa giao cần chú ý (thiếu hàng, sắp tới ngày giao, khách tới lấy quá hạn), cho badge và banner. Đếm theo cùng phạm vi và quy tắc với bộ lọc `attention`, để số trên badge khớp đúng số dòng khi bấm vào.
   */
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
    return toOrderDetail(row, stockChecks);
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

  private async findRow(
    user: AuthUser,
    tenantId: string,
    id: string,
  ): Promise<OrderDetailResult> {
    // Đơn của tenant khác coi như không tồn tại (contract §0); đơn của chi nhánh khác bị từ chối, như OrderService.
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

    // stockCheck chỉ có tới khi đơn giao, nên cũng không có stockSummary để khớp. Hai loại attention cũng vậy:
    // đơn đã giao không còn thiếu hàng hay trễ nữa.
    if (query.stockSummary || query.attention) {
      and.push({ status: { in: [...UNSHIPPED_ORDER_STATUSES] } });
    }

    // Đếm ngày giữa các nửa đêm giờ địa phương (cột là `date`, tức một ngày lịch).
    if (query.attention === 'DUE_SOON') {
      const cutoff = businessDate();
      cutoff.setUTCDate(cutoff.getUTCDate() + DUE_SOON_DAYS);
      and.push({ requestedDeliveryDate: { not: null, lte: cutoff } });
    }

    // Khách hẹn lấy hàng nhưng quá hạn mà vẫn chưa tới: nhân viên cần liên hệ. Chỉ đánh cờ, không tự huỷ.
    if (query.attention === 'PICKUP_OVERDUE') {
      and.push({
        fulfillmentType: FulfillmentType.STORE_PICKUP,
        status: OrderStatus.PACKED,
        requestedDeliveryDate: { not: null, lt: businessDate() },
      });
    }

    return { AND: and };
  }

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

  /**
   * Trang sắp theo độ gấp (gấp nhất trước). `priority` là cột chuỗi nên DB sắp sai; mỗi mức là một nhóm, mới nhất trước trong nhóm. Trang được cắt qua các nhóm lần lượt: đếm mỗi nhóm, và mỗi nhóm chỉ đọc tối đa một lần.
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
   * Bộ lọc stockSummary. Summary tính từ tồn sống, không lưu nên DB không lọc được: các đơn chưa giao được lọc theo bộ lọc khác rồi mới lọc, sắp và phân trang trong bộ nhớ. Giới hạn theo số đơn chờ giao, không theo lịch sử; ở quy mô một shop thì ổn, nếu không ổn thì tính trước.
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
      .filter((order) => {
        const summary = summarizeStock(
          order.items.map((line) => stockChecks.get(line.id)),
        );
        if (query.stockSummary && summary !== query.stockSummary) return false;
        return query.attention !== 'SHORT' || isShort(summary);
      })
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

/** Ba kiểu sắp xếp đó nhưng trong bộ nhớ, cho bộ lọc stockSummary. Phải khớp với `orderByFor` và `pageByPriority`. */
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

/** Lọc `cashRemittanceStatus` theo Payment BALANCE. NOT_APPLICABLE là không có gì phải nộp: không có dòng BALANCE, hoặc dòng chưa từng chờ shipper nộp. */
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
