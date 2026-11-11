import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { Prisma } from '../../../generated/prisma/client';
import { paginate, skipFor } from '../../common/utils/pagination';
import { withNestedProfile } from '../../common/utils/user-profile';
import { ErrorCode } from '../../common/errors/error-codes';
import type { AuthUser } from '../../common/types/auth-user.type';
import {
  PaymentMethod,
  SepayResolution,
} from '../../common/constants/payment-method';
import { CashFlowCategory } from '../../common/constants/cash-flow-category';
import { writeUnallocatedCashFlow } from '../orders/order-cash-flow';
import { sepayNeedsActionWhere } from './sepay-needs-action';
import { QuerySepayTransactionDto } from './dto/query-sepay-transaction.dto';
import { ResolveSepayTransactionDto } from './dto/resolve-sepay-transaction.dto';

const INCLUDE = {
  order: { select: { id: true, code: true } },
  resolvedBy: {
    select: {
      id: true,
      phoneNumber: true,
      profileFirstName: true,
      profileLastName: true,
    },
  },
} as const satisfies Prisma.SepayTransactionInclude;

type Row = Prisma.SepayTransactionGetPayload<{ include: typeof INCLUDE }>;

/** Một dòng sổ như API trả: tiền là number, người xử lý lồng `profile`. */
function toResponse(row: Row) {
  return {
    id: row.id,
    outcome: row.outcome,
    rejectReason: row.rejectReason,
    amount: Number(row.amount),
    excessAmount: Number(row.excessAmount),
    paymentReference: row.paymentReference,
    content: row.content,
    sepayTransactionId: row.sepayTransactionId,
    order: row.order,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
    resolvedBy: row.resolvedBy ? withNestedProfile(row.resolvedBy) : null,
    resolution: row.resolution,
    resolutionNote: row.resolutionNote,
  };
}

@Injectable()
export class SepayTransactionService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(tenantId: string, query: QuerySepayTransactionDto) {
    const where: Prisma.SepayTransactionWhereInput = {
      tenantId,
      ...(query.outcome ? { outcome: query.outcome } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
      ...(query.unresolved ? { AND: [sepayNeedsActionWhere(tenantId)] } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.sepayTransaction.findMany({
        where,
        include: INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: skipFor(query.page, query.limit),
        take: query.limit,
      }),
      this.prisma.sepayTransaction.count({ where }),
    ]);
    return paginate(rows.map(toResponse), total, query.page, query.limit);
  }

  /**
   * Đánh dấu một giao dịch đã xử lý, một lần (`resolved_at IS NULL` là lệnh chiếm). Chỉ bốn cột xử lý được ghi; số tiền, kết cục, đơn của dòng sổ không bao giờ bị sửa.
   * `REFUNDED_MANUALLY` còn ghi dòng chi `UNALLOCATED_REFUND` (cùng số với dòng thu `UNALLOCATED_RECEIPT` của giao dịch), để sổ thu chi khớp sao kê sau khi chủ hoàn tiền ngoài hệ thống. Giao dịch không có dòng thu đó (vd. đã chốt cho đơn, phần dư hoàn bằng route hoàn tiền của đơn) thì từ chối: không có gì để hoàn ở đây.
   */
  async resolve(
    user: AuthUser,
    tenantId: string,
    id: string,
    dto: ResolveSepayTransactionDto,
  ) {
    const exists = await this.prisma.sepayTransaction.findFirst({
      where: { id, tenantId },
      select: { id: true },
    });
    if (!exists) {
      throw new NotFoundException({
        code: ErrorCode.SEPAY_TRANSACTION_NOT_FOUND,
        message: 'SePay transaction not found',
      });
    }

    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.sepayTransaction.updateMany({
        where: { id, tenantId, resolvedAt: null },
        data: {
          resolvedAt: new Date(),
          resolvedById: user.userId,
          resolution: dto.resolution,
          resolutionNote: dto.note?.trim() || null,
        },
      });
      if (claimed.count !== 1) {
        throw new ConflictException({
          code: ErrorCode.SEPAY_TRANSACTION_ALREADY_RESOLVED,
          message: 'This transaction has already been resolved',
        });
      }
      if (dto.resolution !== SepayResolution.REFUNDED_MANUALLY) return;

      const receipt = await tx.cashFlow.findFirst({
        where: {
          sepayLedgerId: id,
          category: CashFlowCategory.UNALLOCATED_RECEIPT,
        },
        select: {
          amount: true,
          sepayTransactionId: true,
          paymentReference: true,
        },
      });
      if (!receipt) {
        throw new ConflictException({
          code: ErrorCode.SEPAY_TRANSACTION_NOT_REFUNDABLE,
          message:
            'Only money booked as an unallocated receipt can be marked refunded here',
        });
      }
      await writeUnallocatedCashFlow(tx, {
        tenantId,
        category: CashFlowCategory.UNALLOCATED_REFUND,
        amount: receipt.amount,
        ledgerId: id,
        // Hoàn ngoài hệ thống: SePay chỉ báo tiền vào, tiền ra là chuyển khoản của chủ.
        method: PaymentMethod.BANK_TRANSFER,
        createdById: user.userId,
        sepayTransactionId: receipt.sepayTransactionId,
        paymentReference: receipt.paymentReference,
        description: `Hoàn tiền chuyển khoản không gắn được đơn${dto.note ? `: ${dto.note.trim()}` : ''}`,
      });
    });

    const row = await this.prisma.sepayTransaction.findUniqueOrThrow({
      where: { id },
      include: INCLUDE,
    });
    return toResponse(row);
  }
}
