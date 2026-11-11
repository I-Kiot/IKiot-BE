import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { paginate, skipFor } from '../../common/utils/pagination';
import type { AuthUser } from '../../common/types/auth-user.type';
import { OrderStatus } from '../../common/constants/order-status';
import {
  CashFlowCategory,
  CashFlowFund,
} from '../../common/constants/cash-flow-category';
import {
  PaymentKind,
  PaymentMethod,
} from '../../common/constants/payment-method';
import { sepayNeedsActionWhere } from '../sepay-transactions/sepay-needs-action';
import {
  HELD_NET_SQL,
  HELD_UNDECIDED_ORDER_SQL,
} from '../orders/held-undecided';
import { orderScope } from './stats-scope';
import { businessDatesOf } from './stats-math';
import type { SalesJournalQueryDto } from './dto/stats-query.dto';

/** Số dòng chi tiết mỗi danh sách của báo cáo đối soát; tổng và số đếm tính trên tất cả. */
const UNRECONCILED_LIST_LIMIT = 50;

/** Cùng cách ghép tên như `StatsService`: chưa có tên thì `null`. */
function fullName(
  user: {
    profileFirstName: string | null;
    profileLastName: string | null;
  } | null,
): string | null {
  if (!user?.profileFirstName) return null;
  return `${user.profileFirstName} ${user.profileLastName ?? ''}`.trim();
}

/**
 * Hai báo cáo đọc sổ, tách khỏi `StatsService` (vốn đã dài): `GET /stats/sales-journal` (các bút toán doanh thu nguyên bản, nền cho mọi báo cáo kế toán) và
 * `GET /stats/unreconciled` (tiền chưa khớp: tiền shipper đang giữ, giao dịch SePay chưa xử lý, đơn trả dư, tiền chưa gắn đơn, quỹ chủ, tiền mặt quầy kho, hoàn tiền mặt từ két).
 */
@Injectable()
export class StatsReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Bút toán doanh thu kèm dòng, phân trang, mới nhất trước. `totals` cộng trên cả bộ lọc (không chỉ trang này). Khoảng ngày lọc theo `business_date` địa phương. */
  async getSalesJournal(user: AuthUser, query: SalesJournalQueryDto) {
    const scope = orderScope(user, query.branchId);
    const { from, to } = businessDatesOf(query.range());
    const where: Prisma.SalesJournalEntryWhereInput = {
      tenantId: user.tenantId ?? undefined,
      businessDate: {
        gte: new Date(`${from}T00:00:00.000Z`),
        lte: new Date(`${to}T00:00:00.000Z`),
      },
      ...(scope.branchId ? { branchId: scope.branchId } : {}),
      ...(query.entryType ? { entryType: query.entryType } : {}),
      ...(query.orderId ? { orderId: query.orderId } : {}),
    };
    const { page, limit } = query;

    const [rows, total, totals] = await Promise.all([
      this.prisma.salesJournalEntry.findMany({
        where,
        orderBy: [
          { businessDate: 'desc' },
          { postedAt: 'desc' },
          { id: 'asc' },
        ],
        skip: skipFor(page, limit),
        take: limit,
        include: {
          order: { select: { code: true } },
          lines: {
            orderBy: { id: 'asc' },
            include: {
              orderItem: {
                select: { productName: true, sku: true, lineType: true },
              },
            },
          },
        },
      }),
      this.prisma.salesJournalEntry.count({ where }),
      this.prisma.salesJournalEntry.aggregate({
        where,
        _sum: {
          goodsAmount: true,
          shippingAmount: true,
          otherIncomeAmount: true,
          totalAmount: true,
          cogsAmount: true,
          shippingCost: true,
          channelFee: true,
        },
      }),
    ]);

    const locations = await this.prisma.location.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.branchId))] } },
      select: { id: true, name: true },
    });
    const nameOf = new Map(locations.map((l) => [l.id, l.name]));
    const sum = (value: Prisma.Decimal | null | undefined) =>
      Number(value ?? 0);

    const data = rows.map((row) => ({
      id: row.id,
      entryType: row.entryType,
      source: row.source,
      orderId: row.orderId,
      orderCode: row.order.code,
      orderReturnId: row.orderReturnId,
      branchId: row.branchId,
      branchName: nameOf.get(row.branchId) ?? null,
      businessDate: row.businessDate.toISOString().slice(0, 10),
      postedAt: row.postedAt,
      goodsAmount: Number(row.goodsAmount),
      shippingAmount: Number(row.shippingAmount),
      otherIncomeAmount: Number(row.otherIncomeAmount),
      totalAmount: Number(row.totalAmount),
      cogsAmount: Number(row.cogsAmount),
      shippingCost: Number(row.shippingCost),
      channelFee: Number(row.channelFee),
      customerId: row.customerId,
      assigneeId: row.assigneeId,
      creatorId: row.creatorId,
      channel: row.channel,
      fulfillmentType: row.fulfillmentType,
      actorId: row.actorId,
      lines: row.lines.map((line) => ({
        id: line.id,
        orderItemId: line.orderItemId,
        productItemId: line.productItemId,
        productName: line.orderItem.productName,
        sku: line.orderItem.sku,
        lineType: line.orderItem.lineType,
        quantity: line.quantity,
        amount: Number(line.amount),
        cogs: Number(line.cogs),
      })),
    }));

    return {
      ...paginate(data, total, page, limit),
      totals: {
        goodsAmount: sum(totals._sum.goodsAmount),
        shippingAmount: sum(totals._sum.shippingAmount),
        otherIncomeAmount: sum(totals._sum.otherIncomeAmount),
        totalAmount: sum(totals._sum.totalAmount),
        cogsAmount: sum(totals._sum.cogsAmount),
        shippingCost: sum(totals._sum.shippingCost),
        channelFee: sum(totals._sum.channelFee),
      },
    };
  }

  /**
   * Báo cáo "tiền chưa khớp": tình trạng tại lúc gọi (không theo kỳ). Người xem gắn một chi nhánh chỉ thấy phần của chi nhánh đó (`scope: 'BRANCH'`); những khoản không thuộc chi nhánh nào
   * (`unallocatedBank`, giao dịch SePay chưa gắn đơn) là `null` / bị bỏ khỏi họ.
   */
  async getUnreconciled(user: AuthUser, branchId?: string) {
    const scope = orderScope(user, branchId);
    const tenantId = user.tenantId;
    const branch = scope.branchId;
    const wholeTenant = !branch;
    const orderBranch = branch
      ? Prisma.sql`AND o.branch_id = ${branch}`
      : Prisma.empty;
    const flowBranch = branch
      ? Prisma.sql`AND cf.location_id = ${branch}`
      : Prisma.empty;

    const [
      shipperRows,
      overpaid,
      sepayRows,
      sepayTotals,
      unallocated,
      ownerRows,
      warehouseRows,
      refundRows,
      coverage,
      heldRows,
    ] = await Promise.all([
      // Tiền mặt shipper đã thu nhưng chưa nộp (chủ chưa xác nhận): đang nằm trong tay shipper, chưa vào quỹ nào.
      this.prisma.$queryRaw<
        {
          collectorId: string | null;
          orderCount: number;
          amount: Prisma.Decimal;
          oldestPaidAt: Date | null;
        }[]
      >`
        SELECT p.collected_by AS "collectorId",
               COUNT(DISTINCT p.order_id)::int AS "orderCount",
               COALESCE(SUM(p.amount), 0) AS "amount",
               MIN(p.paid_at) AS "oldestPaidAt"
        FROM payments p
        JOIN orders o ON o.id = p.order_id
        WHERE p.tenant_id = ${tenantId}
          AND p.method = ${PaymentMethod.CASH}
          AND p.status = 'PAID'
          AND p.remittance_status = 'PENDING'
          ${orderBranch}
        GROUP BY 1
        ORDER BY MIN(p.paid_at) ASC
      `,
      // Đơn khách đã trả nhiều hơn tổng đơn (sau hoàn tiền và tiền thối): cần hoàn phần dư.
      this.prisma.$queryRaw<
        {
          orderId: string;
          code: string;
          grandTotal: Prisma.Decimal;
          overpaidBy: Prisma.Decimal;
        }[]
      >`
        SELECT o.id AS "orderId", o.code AS "code", o.grand_total AS "grandTotal",
               (SUM(CASE WHEN p.kind IN (${PaymentKind.FULL}, ${PaymentKind.DEPOSIT}, ${PaymentKind.BALANCE})
                         THEN p.amount ELSE -p.amount END) - o.grand_total) AS "overpaidBy"
        FROM orders o
        JOIN payments p ON p.order_id = o.id AND p.status = 'PAID'
        WHERE o.tenant_id = ${tenantId}
          AND o.status <> ${OrderStatus.CANCELLED}
          ${orderBranch}
        GROUP BY o.id, o.code, o.grand_total
        HAVING SUM(CASE WHEN p.kind IN (${PaymentKind.FULL}, ${PaymentKind.DEPOSIT}, ${PaymentKind.BALANCE})
                        THEN p.amount ELSE -p.amount END) > o.grand_total
        ORDER BY 4 DESC
        LIMIT ${UNRECONCILED_LIST_LIMIT}
      `,
      // Giao dịch SePay cần người xử lý: bị từ chối, không gắn được đơn, chuyển thiếu (chưa đủ), hoặc dư chưa hoàn; chưa `resolved`.
      this.prisma.sepayTransaction.findMany({
        where: sepayNeedsActionWhere(tenantId, branch),
        orderBy: { createdAt: 'desc' },
        take: UNRECONCILED_LIST_LIMIT,
        include: { order: { select: { code: true } } },
      }),
      this.prisma.sepayTransaction.aggregate({
        where: sepayNeedsActionWhere(tenantId, branch),
        _count: { _all: true },
        _sum: { amount: true, excessAmount: true },
      }),
      // Tiền về tài khoản không gắn được đơn: đã ghi UNALLOCATED_RECEIPT (D2); trừ phần đã hoàn tay. Không thuộc chi nhánh nào.
      wholeTenant
        ? this.prisma.cashFlow.groupBy({
            by: ['category'],
            where: {
              tenantId: tenantId ?? undefined,
              category: {
                in: [
                  CashFlowCategory.UNALLOCATED_RECEIPT,
                  CashFlowCategory.UNALLOCATED_REFUND,
                ],
              },
            },
            _sum: { amount: true },
            _count: { _all: true },
          })
        : Promise.resolve(null),
      // Quỹ chủ (tiền mặt giao thẳng chủ: shipper nộp, trả NCC bằng tiền mặt): thu - chi theo loại, từ trước đến nay.
      this.prisma.$queryRaw<
        {
          category: string;
          flowType: string;
          amount: Prisma.Decimal;
          count: number;
        }[]
      >`
        SELECT cf.category AS "category", cf.flow_type AS "flowType",
               COALESCE(SUM(cf.amount), 0) AS "amount", COUNT(*)::int AS "count"
        FROM cash_flows cf
        WHERE cf.tenant_id = ${tenantId} AND cf.fund = ${CashFlowFund.OWNER}
          ${flowBranch}
        GROUP BY 1, 2
      `,
      // Tiền mặt thu tại quầy một KHO (không có két): nằm trong quỹ DRAWER nhưng không đối soát két nào.
      this.prisma.$queryRaw<
        {
          locationId: string;
          locationName: string;
          income: Prisma.Decimal;
          expense: Prisma.Decimal;
        }[]
      >`
        SELECT cf.location_id AS "locationId", l.name AS "locationName",
               COALESCE(SUM(cf.amount) FILTER (WHERE cf.flow_type = 'INCOME'), 0) AS "income",
               COALESCE(SUM(cf.amount) FILTER (WHERE cf.flow_type = 'EXPENSE'), 0) AS "expense"
        FROM cash_flows cf
        JOIN locations l ON l.id = cf.location_id
        WHERE cf.tenant_id = ${tenantId}
          AND cf.fund = ${CashFlowFund.DRAWER}
          AND l.location_type = 'WAREHOUSE'
          ${flowBranch}
        GROUP BY 1, 2
        ORDER BY 2
      `,
      // Hoàn tiền mặt ghi vào két của chi nhánh đơn (D5) trong khi tiền mặt của đơn không đi qua két đó (shipper nộp chủ, hoặc thu tại kho): đối soát két chi nhánh sẽ hụt đúng bằng số này.
      this.prisma.$queryRaw<
        {
          locationId: string;
          locationName: string;
          count: number;
          amount: Prisma.Decimal;
        }[]
      >`
        SELECT cf.location_id AS "locationId", l.name AS "locationName",
               COUNT(*)::int AS "count", COALESCE(SUM(cf.amount), 0) AS "amount"
        FROM cash_flows cf
        JOIN locations l ON l.id = cf.location_id
        WHERE cf.tenant_id = ${tenantId}
          AND cf.category = ${CashFlowCategory.ORDER_REFUND}
          AND cf.fund = ${CashFlowFund.DRAWER}
          AND cf.payment_method = ${PaymentMethod.CASH}
          AND EXISTS (SELECT 1 FROM cash_flows r
                       WHERE r.order_id = cf.order_id
                         AND r.category = ${CashFlowCategory.ORDER_PAYMENT}
                         AND r.payment_method = ${PaymentMethod.CASH}
                         AND (r.fund = ${CashFlowFund.OWNER}
                              OR r.location_id IS DISTINCT FROM cf.location_id))
          ${flowBranch}
        GROUP BY 1, 2
        ORDER BY 2
      `,
      // Phạm vi của sổ doanh thu: đơn COMPLETED cũ (trước migration, D9 không backfill) không có bút toán nên không có mặt trong các báo cáo doanh thu.
      this.prisma.$queryRaw<
        { ordersWithoutJournal: number; firstJournalAt: Date | null }[]
      >`
        SELECT (SELECT COUNT(*)::int FROM orders o
                 WHERE o.tenant_id = ${tenantId} AND o.status = ${OrderStatus.COMPLETED}
                   ${orderBranch}
                   AND NOT EXISTS (SELECT 1 FROM sales_journal_entries s
                                    WHERE s.order_id = o.id AND s.entry_type = 'SALE')) AS "ordersWithoutJournal",
               (SELECT MIN(posted_at) FROM sales_journal_entries
                 WHERE tenant_id = ${tenantId}) AS "firstJournalAt"
      `,
      // Đơn RETURNED / CANCELLED mà shop còn giữ tiền chưa quyết định (hoàn hay giữ): cùng quy tắc `held-undecided.ts`.
      this.prisma.$queryRaw<
        {
          orderId: string;
          code: string;
          status: string;
          held: Prisma.Decimal;
          closedAt: Date;
        }[]
      >`
        SELECT o.id AS "orderId", o.code AS "code", o.status AS "status",
               ${HELD_NET_SQL} AS "held", o.updated_at AS "closedAt"
        FROM orders o
        WHERE o.tenant_id = ${tenantId}
          AND ${HELD_UNDECIDED_ORDER_SQL}
          AND ${HELD_NET_SQL} > 0
          ${orderBranch}
        ORDER BY o.updated_at ASC, o.id ASC
      `,
    ]);

    // Tên người thu (shipper) trong một lần đọc.
    const collectorIds = shipperRows
      .map((r) => r.collectorId)
      .filter((id): id is string => id !== null);
    const collectors = await this.prisma.user.findMany({
      where: { id: { in: collectorIds } },
      select: { id: true, profileFirstName: true, profileLastName: true },
    });
    const collectorName = new Map(collectors.map((u) => [u.id, fullName(u)]));

    const ownerIncome = ownerRows
      .filter((r) => r.flowType === 'INCOME')
      .reduce((n, r) => n + Number(r.amount), 0);
    const ownerExpense = ownerRows
      .filter((r) => r.flowType === 'EXPENSE')
      .reduce((n, r) => n + Number(r.amount), 0);
    const warehouseItems = warehouseRows.map((r) => ({
      locationId: r.locationId,
      locationName: r.locationName,
      income: Number(r.income),
      expense: Number(r.expense),
      net: Number(r.income) - Number(r.expense),
    }));
    const unallocatedOf = (category: string) =>
      Number(
        unallocated?.find((r) => r.category === category)?._sum.amount ?? 0,
      );
    const receipts = unallocatedOf(CashFlowCategory.UNALLOCATED_RECEIPT);
    const refunds = unallocatedOf(CashFlowCategory.UNALLOCATED_REFUND);

    return {
      asOf: new Date(),
      scope: wholeTenant ? 'TENANT' : 'BRANCH',
      shipperCash: {
        orderCount: shipperRows.reduce((n, r) => n + r.orderCount, 0),
        amount: shipperRows.reduce((n, r) => n + Number(r.amount), 0),
        items: shipperRows.map((r) => ({
          collectorId: r.collectorId,
          collectorName: r.collectorId
            ? (collectorName.get(r.collectorId) ?? null)
            : null,
          orderCount: r.orderCount,
          amount: Number(r.amount),
          oldestPaidAt: r.oldestPaidAt,
        })),
      },
      sepayExceptions: {
        count: sepayTotals._count._all,
        amount: Number(sepayTotals._sum.amount ?? 0),
        excessAmount: Number(sepayTotals._sum.excessAmount ?? 0),
        items: sepayRows.map((r) => ({
          id: r.id,
          outcome: r.outcome,
          rejectReason: r.rejectReason,
          amount: Number(r.amount),
          excessAmount: Number(r.excessAmount),
          paymentReference: r.paymentReference,
          content: r.content,
          orderId: r.orderId,
          orderCode: r.order?.code ?? null,
          createdAt: r.createdAt,
        })),
      },
      overpaidOrders: {
        count: overpaid.length,
        amount: overpaid.reduce((n, r) => n + Number(r.overpaidBy), 0),
        items: overpaid.map((r) => ({
          orderId: r.orderId,
          code: r.code,
          grandTotal: Number(r.grandTotal),
          overpaidBy: Number(r.overpaidBy),
        })),
      },
      heldUndecided: {
        count: heldRows.length,
        amount: heldRows.reduce((n, r) => n + Number(r.held), 0),
        items: heldRows.slice(0, UNRECONCILED_LIST_LIMIT).map((r) => ({
          orderId: r.orderId,
          code: r.code,
          status: r.status,
          held: Number(r.held),
          closedAt: r.closedAt,
        })),
      },
      unallocatedBank: wholeTenant
        ? { receipts, refunds, net: receipts - refunds }
        : null,
      ownerFund: {
        income: ownerIncome,
        expense: ownerExpense,
        balance: ownerIncome - ownerExpense,
        byCategory: ownerRows.map((r) => ({
          category: r.category,
          flowType: r.flowType,
          amount: Number(r.amount),
          count: r.count,
        })),
      },
      warehouseCounterCash: {
        net: warehouseItems.reduce((n, r) => n + r.net, 0),
        items: warehouseItems,
      },
      cashRefundsAgainstDrawer: {
        count: refundRows.reduce((n, r) => n + r.count, 0),
        amount: refundRows.reduce((n, r) => n + Number(r.amount), 0),
        items: refundRows.map((r) => ({
          locationId: r.locationId,
          locationName: r.locationName,
          count: r.count,
          amount: Number(r.amount),
        })),
      },
      journalCoverage: {
        firstJournalAt: coverage[0]?.firstJournalAt ?? null,
        ordersWithoutJournal: coverage[0]?.ordersWithoutJournal ?? 0,
      },
    };
  }
}
