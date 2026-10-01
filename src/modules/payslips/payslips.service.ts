import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { paginate, skipFor } from '../../common/utils/pagination';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { EMPLOYEE_VISIBLE_PAYSLIP_STATUSES } from '../payroll-periods/payroll-period.constants';
import type { Prisma } from '../../../generated/prisma/client';
import { ErrorCode } from '../../common/errors/error-codes';

const PERIOD_SELECT = {
  select: {
    id: true,
    name: true,
    periodStart: true,
    periodEnd: true,
    status: true,
    paidAt: true,
  },
} as const;

/** An employee reading their own payslips: own only, and only once the period reaches REVIEW - a DRAFT is the manager's working copy and a CANCELLED one describes a period that never happened, while REVIEW is visible so figures can be queried before APPROVED fixes them. */
@Injectable()
export class PayslipService {
  constructor(private readonly prisma: PrismaService) {}

  private visibleTo(
    tenantId: string,
    userId: string,
  ): Prisma.PayslipWhereInput {
    return {
      tenantId,
      userId,
      status: { in: EMPLOYEE_VISIBLE_PAYSLIP_STATUSES },
    };
  }

  async findMine(tenantId: string, userId: string, query: PaginationQueryDto) {
    const where = this.visibleTo(tenantId, userId);
    const [rows, total] = await Promise.all([
      this.prisma.payslip.findMany({
        where,
        include: { payrollPeriod: PERIOD_SELECT },
        orderBy: { periodEnd: 'desc' },
        skip: skipFor(query.page, query.limit),
        take: query.limit,
      }),
      this.prisma.payslip.count({ where }),
    ]);

    return paginate(
      rows.map((row) => this.toResponse(row)),
      total,
      query.page,
      query.limit,
    );
  }

  async findMineOne(tenantId: string, userId: string, id: string) {
    const payslip = await this.prisma.payslip.findFirst({
      where: { ...this.visibleTo(tenantId, userId), id },
      include: {
        payrollPeriod: PERIOD_SELECT,
        allowanceLines: true,
        bonusLines: true,
        deductionLines: true,
        leaveLines: { include: { dates: true } },
        manualAdjustments: true,
      },
    });
    if (!payslip) {
      throw new NotFoundException({
        code: ErrorCode.PAYSLIP_NOT_FOUND,
        message: 'No payslip available for you to view',
      });
    }
    return this.toResponse(payslip);
  }

  /** Decimals become numbers - every one of these is displayed as money. */
  private toResponse<T extends Record<string, unknown>>(payslip: T): T {
    const money = [
      'totalWorkedDays',
      'totalWorkedHours',
      'basePay',
      'overtimePay',
      'paidLeaveDays',
      'unpaidLeaveDays',
      'paidLeavePay',
      'unpaidLeaveDeduction',
      'bonus',
      'allowance',
      'grossSalary',
      'deduction',
      'netSalary',
    ];
    const shaped: Record<string, unknown> = { ...payslip };
    for (const key of money) {
      if (shaped[key] !== null && shaped[key] !== undefined) {
        shaped[key] = Number(shaped[key]);
      }
    }
    return shaped as T;
  }
}
