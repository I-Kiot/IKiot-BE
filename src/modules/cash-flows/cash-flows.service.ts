import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ErrorCode } from '../../common/errors/error-codes';

/** Chỉ đọc sổ quỹ; việc ghi do các sự kiện thu chi đảm nhiệm. `findAll` chưa lọc vì danh sách lọc thuộc module stats. */
@Injectable()
export class CashFlowService {
  constructor(private readonly prisma: PrismaService) {}

  findAll(tenantId?: string) {
    return this.prisma.cashFlow.findMany({
      where: { ...(tenantId ? { tenantId } : {}) },
      orderBy: { createdAt: 'desc' },
    });
  }

  // Dùng findFirst + throw tay thay vì findFirstOrThrow: lỗi not-found của Prisma không phải HttpException, và bản ghi của tenant khác phải không phân biệt được với bản ghi không tồn tại.
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
