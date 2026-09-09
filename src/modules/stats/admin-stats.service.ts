import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { changePct, previousPeriod, ratioPct } from './stats-math';
import {
  BUCKET_FORMAT,
  GroupBy,
  LIVE_SUBSCRIPTION_STATUSES,
  RECENT_INVOICES_LIMIT,
  TOP_TENANTS_LIMIT,
  TZ_NAME,
} from './stats.constants';
import { TicketStatus } from '../tickets/ticket.constants';
import type { AdminOverviewQueryDto } from './dto/stats-query.dto';
import type { DateRange } from './stats-math';

const PAID = 'PAID';

/** Ported from `AdminStatsService` - the operator's dashboard across every tenant. Revenue here is what shops pay iKiot for their plans, never what shops take at the till: separate ledgers against separate bank accounts. */
@Injectable()
export class AdminStatsService {
  constructor(private readonly prisma: PrismaService) {}

  async getOverview(query: AdminOverviewQueryDto) {
    const range = query.range();
    const previous = previousPeriod(range);
    const groupBy =
      query.groupBy === GroupBy.MONTH ? GroupBy.MONTH : GroupBy.DAY;

    const [
      tenantsByStatus,
      totalTenants,
      newTenants,
      previousNewTenants,
      subscriptionsByStatus,
      planDistribution,
      revenueAllTime,
      revenueInPeriod,
      revenuePreviousPeriod,
      revenueSeries,
      tenantGrowth,
      ticketsByStatus,
      sepayLinked,
      topTenants,
      recentInvoices,
    ] = await Promise.all([
      this.prisma.tenant.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.tenant.count(),
      this.prisma.tenant.count({ where: { createdAt: this.between(range) } }),
      this.prisma.tenant.count({
        where: { createdAt: this.between(previous) },
      }),
      this.prisma.subscription.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      this.planDistribution(),
      this.prisma.subscriptionInvoice.aggregate({
        where: { status: PAID },
        _sum: { amount: true },
      }),
      this.paidRevenue(range),
      this.paidRevenue(previous),
      this.revenueSeries(range, groupBy),
      this.tenantGrowth(range, groupBy),
      this.prisma.ticket.groupBy({ by: ['status'], _count: { _all: true } }),
      // "Has an operator linked this shop to SePay yet" - an empty string counts as not linked, same as the old `$ifNull` guard.
      this.prisma.tenant.count({
        where: {
          bankingSepayWebhookApiKey: { not: null },
          NOT: { bankingSepayWebhookApiKey: '' },
        },
      }),
      this.topTenants(),
      this.prisma.subscriptionInvoice.findMany({
        orderBy: { createdAt: 'desc' },
        take: RECENT_INVOICES_LIMIT,
        include: {
          plan: { select: { planName: true, planCode: true } },
          tenant: { select: { name: true } },
        },
      }),
    ]);

    const tenantStatus = this.countBy(tenantsByStatus, 'status');
    const subscriptionStatus = this.countBy(subscriptionsByStatus, 'status');
    const tickets = this.countBy(ticketsByStatus, 'status');

    // Trials are excluded from the denominator on purpose: a shop still inside its trial hasn't had the chance to convert, so counting it would make the rate sag every time marketing works.
    const paying =
      (subscriptionStatus.ACTIVE ?? 0) + (subscriptionStatus.PAST_DUE ?? 0);
    const decided =
      paying +
      (subscriptionStatus.EXPIRED ?? 0) +
      (subscriptionStatus.CANCELLED ?? 0);

    return {
      period: range,
      tenants: {
        total: totalTenants,
        active: tenantStatus.ACTIVE ?? 0,
        inactive: tenantStatus.INACTIVE ?? 0,
        suspended: tenantStatus.SUSPENDED ?? 0,
        newInPeriod: newTenants,
        changePct: changePct(newTenants, previousNewTenants),
      },
      subscriptions: {
        byStatus: {
          TRIAL: subscriptionStatus.TRIAL ?? 0,
          ACTIVE: subscriptionStatus.ACTIVE ?? 0,
          PAST_DUE: subscriptionStatus.PAST_DUE ?? 0,
          EXPIRED: subscriptionStatus.EXPIRED ?? 0,
          CANCELLED: subscriptionStatus.CANCELLED ?? 0,
        },
        planDistribution,
        conversionRate: ratioPct(paying, decided),
      },
      revenue: {
        total: Number(revenueAllTime._sum.amount ?? 0),
        inPeriod: revenueInPeriod.total,
        invoiceCountInPeriod: revenueInPeriod.count,
        changePct: changePct(
          revenueInPeriod.total,
          revenuePreviousPeriod.total,
        ),
        groupBy,
        series: revenueSeries,
      },
      tenantGrowth,
      tickets: {
        open:
          (tickets[TicketStatus.OPEN] ?? 0) +
          (tickets[TicketStatus.IN_PROGRESS] ?? 0),
        resolved:
          (tickets[TicketStatus.RESOLVED] ?? 0) +
          (tickets[TicketStatus.CLOSED] ?? 0),
        total: Object.values(tickets).reduce((sum, n) => sum + n, 0),
      },
      sepay: { linked: sepayLinked, total: totalTenants },
      topTenants,
      recentInvoices,
    };
  }

  // ─── Pieces ────────────────────────────────────────────────────────────────

  /** Platform revenue is measured by when an invoice was paid, not when it was raised - an invoice issued in March and settled in April is April's money. */
  private async paidRevenue({ fromDate, toDate }: DateRange) {
    const result = await this.prisma.subscriptionInvoice.aggregate({
      where: { status: PAID, paidAt: { gte: fromDate, lte: toDate } },
      _sum: { amount: true },
      _count: { _all: true },
    });
    return {
      total: Number(result._sum.amount ?? 0),
      count: result._count._all,
    };
  }

  private async revenueSeries(
    { fromDate, toDate }: DateRange,
    groupBy: GroupBy,
  ) {
    const rows = await this.prisma.$queryRaw<
      { bucket: string; revenue: Prisma.Decimal; count: number }[]
    >`
      SELECT to_char(paid_at AT TIME ZONE ${TZ_NAME}, ${BUCKET_FORMAT[groupBy]}) AS "bucket",
             COALESCE(SUM(amount), 0) AS "revenue",
             COUNT(*)::int            AS "count"
      FROM subscription_invoices
      WHERE status = ${PAID}
        AND paid_at >= ${fromDate}
        AND paid_at <= ${toDate}
      GROUP BY 1
      ORDER BY 1
    `;
    return rows.map((row) => ({
      bucket: row.bucket,
      revenue: Number(row.revenue),
      count: row.count,
    }));
  }

  private async tenantGrowth(
    { fromDate, toDate }: DateRange,
    groupBy: GroupBy,
  ) {
    const rows = await this.prisma.$queryRaw<
      { bucket: string; count: number }[]
    >`
      SELECT to_char(created_at AT TIME ZONE ${TZ_NAME}, ${BUCKET_FORMAT[groupBy]}) AS "bucket",
             COUNT(*)::int AS "count"
      FROM tenants
      WHERE created_at >= ${fromDate}
        AND created_at <= ${toDate}
      GROUP BY 1
      ORDER BY 1
    `;
    return rows;
  }

  /** How many live subscriptions sit on each plan - trials included, they are live. */
  private async planDistribution() {
    const rows = await this.prisma.subscription.groupBy({
      by: ['planId'],
      where: { status: { in: LIVE_SUBSCRIPTION_STATUSES } },
      _count: { _all: true },
    });

    const plans = await this.prisma.plan.findMany({
      where: { id: { in: rows.map((row) => row.planId) } },
      select: { id: true, planCode: true, planName: true },
    });
    const planOf = new Map(plans.map((plan) => [plan.id, plan]));

    return rows
      .map((row) => ({
        planId: row.planId,
        planCode: planOf.get(row.planId)?.planCode ?? null,
        planName: planOf.get(row.planId)?.planName ?? null,
        count: row._count._all,
      }))
      .sort((a, b) => b.count - a.count);
  }

  /** Biggest-paying shops, all time. */
  private async topTenants() {
    const rows = await this.prisma.subscriptionInvoice.groupBy({
      by: ['tenantId'],
      where: { status: PAID },
      _sum: { amount: true },
      _count: { _all: true },
      orderBy: { _sum: { amount: 'desc' } },
      take: TOP_TENANTS_LIMIT,
    });

    const tenants = await this.prisma.tenant.findMany({
      where: { id: { in: rows.map((row) => row.tenantId) } },
      select: { id: true, name: true },
    });
    const nameOf = new Map(tenants.map((tenant) => [tenant.id, tenant.name]));

    return rows.map((row) => ({
      tenantId: row.tenantId,
      name: nameOf.get(row.tenantId) ?? null,
      revenue: Number(row._sum.amount ?? 0),
      invoiceCount: row._count._all,
    }));
  }

  private between({ fromDate, toDate }: DateRange) {
    return { gte: fromDate, lte: toDate };
  }

  private countBy<T extends { _count: { _all: number } }>(
    rows: T[],
    key: keyof T,
  ): Record<string, number> {
    const out: Record<string, number> = {};
    for (const row of rows) {
      const value = row[key];
      if (typeof value !== 'string') continue;
      out[value] = (out[value] ?? 0) + row._count._all;
    }
    return out;
  }
}
