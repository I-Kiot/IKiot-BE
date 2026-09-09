import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ErrorCode } from '../../common/errors/error-codes';

/** Reads over the money ledger; nothing here writes - see the controller. The real filtered listing belongs to the stats module, so `findAll` is still the generated unfiltered list. */
@Injectable()
export class CashFlowService {
  constructor(private readonly prisma: PrismaService) {}

  findAll(tenantId?: string) {
    return this.prisma.cashFlow.findMany({
      where: { ...(tenantId ? { tenantId } : {}) },
      orderBy: { createdAt: 'desc' },
    });
  }

  // findFirst + explicit throw rather than findFirstOrThrow: Prisma's not-found error isn't an HttpException, and a row in another tenant must be indistinguishable from one that doesn't exist.
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
