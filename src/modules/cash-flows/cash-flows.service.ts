import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ErrorCode } from '../../common/errors/error-codes';

/** Đọc sổ quỹ. */
@Injectable()
export class CashFlowService {
  constructor(private readonly prisma: PrismaService) {}

  findAll(tenantId?: string) {
    return this.prisma.cashFlow.findMany({
      where: { ...(tenantId ? { tenantId } : {}) },
      orderBy: { createdAt: 'desc' },
    });
  }

  // Bản ghi tenant khác coi như không tồn tại.
  async findOne(tenantId: string | undefined, id: string) {
    const found = await this.prisma.cashFlow.findFirst({
      where: { id, ...(tenantId ? { tenantId } : {}) },
    });
    if (!found)
      throw new NotFoundException({
        code: ErrorCode.CASH_FLOW_NOT_FOUND,
        message: 'CashFlow not found',
      });
    return found;
  }
}
