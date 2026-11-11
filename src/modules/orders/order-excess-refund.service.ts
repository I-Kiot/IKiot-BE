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

/**
 * `POST /orders/:id/refund-excess` (Phase 6): trả lại phần khách chuyển dư (`paymentSummary.overpaidBy`) của một đơn đã chốt. Một transaction: khoá đơn → khoản REFUND + dòng chi `ORDER_REFUND` (quỹ chi nhánh của đơn nếu tiền mặt) → đồng bộ trạng thái thanh toán → sự kiện `REFUNDED`.
 * Khi hoàn hết phần dư, dòng sổ SePay của đơn có `excess_amount > 0` được đánh dấu đã xử lý (`REFUNDED_MANUALLY`, người hoàn là người xử lý) để khỏi nằm mãi trong danh sách cần đối soát. Hoàn một phần thì dòng sổ còn mở.
 * Quyền `returns:inspect` (quyết định D1: không thêm quyền mới).
 */
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
