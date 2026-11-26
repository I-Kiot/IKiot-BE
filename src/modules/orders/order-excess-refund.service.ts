import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { OrderService } from './orders.service';
import { OrderReadService } from './order-read.service';
import { lockOrder } from './order-lock';
import { recordRefund } from './order-refund';
import { RefundExcessDto } from './dto/refund-excess.dto';
import { SepayResolution } from '../../common/constants/payment-method';
import { ErrorCode } from '../../common/errors/error-codes';
import type { AuthUser } from '../../common/types/auth-user.type';

/** Hoàn phần khách chuyển dư của đơn đã chốt. */
@Injectable()
export class OrderExcessRefundService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrderService,
    private readonly reads: OrderReadService,
  ) {}

  async refundExcess(
    user: AuthUser,
    tenantId: string,
    id: string,
    dto: RefundExcessDto,
  ) {
    const order = await this.prisma.order.findFirst({
      where: { id, tenantId },
      select: { id: true, tenantId: true, code: true, branchId: true },
    });
    if (!order)
      throw new NotFoundException({
        code: ErrorCode.ORDER_NOT_FOUND,
        message: 'Order not found',
      });
    const scope = this.orders.branchScope(user);
    if (scope.branchId !== undefined && order.branchId !== scope.branchId) {
      throw new ForbiddenException({
        code: ErrorCode.ORDER_BRANCH_DENIED,
        message: 'This order does not belong to your branch',
      });
    }

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      if (!(await lockOrder(tx, tenantId, id))) {
        throw new NotFoundException({
          code: ErrorCode.ORDER_NOT_FOUND,
          message: 'Order not found',
        });
      }
      const { derived } = await recordRefund(tx, {
        order,
        amount: dto.amount,
        method: dto.method,
        cap: 'EXCESS',
        actor: user,
        reason: 'EXCESS_PAYMENT',
        note: dto.note ?? null,
        description: `Hoàn phần khách trả dư đơn ${order.code}`,
        now,
      });
      if (derived.overpaidBy === 0) {
        // Có điều kiện `resolved_at IS NULL`: không ghi đè một lần xử lý tay trước đó.
        await tx.sepayTransaction.updateMany({
          where: {
            tenantId,
            orderId: id,
            excessAmount: { gt: 0 },
            resolvedAt: null,
          },
          data: {
            resolvedAt: now,
            resolvedById: user.userId,
            resolution: SepayResolution.REFUNDED_MANUALLY,
            resolutionNote:
              dto.note ?? `Phần trả dư đã hoàn qua đơn ${order.code}`,
          },
        });
      }
    });

    return this.reads.findOne(user, tenantId, id);
  }
}
