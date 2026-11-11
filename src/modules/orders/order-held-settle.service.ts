import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { OrderService } from './orders.service';
import { OrderReadService } from './order-read.service';
import { lockOrder } from './order-lock';
import { recordRefund } from './order-refund';
import { loadHeldUndecided } from './held-undecided';
import { postOtherIncome } from './sales-journal';
import { recordOrderEvent, userActor } from './order-events';
import { SettleHeldDto } from './dto/settle-held.dto';
import { OrderEventType } from '../../common/constants/order-event-type';
import { SalesJournalSource } from '../../common/constants/sales-journal';
import {
  PaymentKind,
  PaymentMethod,
  PaymentRecordStatus,
} from '../../common/constants/payment-method';
import { ErrorCode } from '../../common/errors/error-codes';
import type { AuthUser } from '../../common/types/auth-user.type';

/**
 * `POST /orders/:id/settle-held`: quyết định số tiền "treo" của đơn đã kết thúc (RETURNED / CANCELLED mà shop giữ tiền, chưa hoàn, chưa ghi thu nhập khác; xem `held-undecided.ts`).
 * Một transaction: khoá đơn → đọc lại số treo SAU khoá (không còn treo = 409 `ORDER_NO_HELD_MONEY`, nên bấm hai lần chỉ có một tác dụng) →
 *  - REFUND: `recordRefund` (khoản REFUND + dòng chi ORDER_REFUND + sự kiện REFUNDED), trần = số treo; phần còn lại sau hoàn một phần vẫn treo.
 *  - KEEP: OTHER_INCOME cho toàn bộ số treo, ghi ở NGÀY QUYẾT ĐỊNH (`now`, không lùi ngày) + sự kiện HELD_KEPT. Từ đó đơn không còn treo.
 * Quyền `returns:inspect` (không thêm quyền mới).
 */
@Injectable()
export class OrderHeldSettleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrderService,
    private readonly reads: OrderReadService,
  ) {}

  async settle(
    user: AuthUser,
    tenantId: string,
    id: string,
    dto: SettleHeldDto,
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
      const held = await loadHeldUndecided(tx, id);
      if (held <= 0) {
        throw new ConflictException({
          code: ErrorCode.ORDER_NO_HELD_MONEY,
          message: 'This order has no held money waiting for a decision',
        });
      }

      if (dto.action === 'KEEP') {
        await postOtherIncome(tx, {
          orderId: id,
          kept: held,
          actor: { id: user.userId },
          now,
          source: SalesJournalSource.HELD_DECISION,
        });
        await recordOrderEvent(tx, userActor(user), {
          tenantId,
          orderId: id,
          type: OrderEventType.HELD_KEPT,
          metadata: { amount: held, note: dto.note ?? null },
        });
        return;
      }

      const amount = dto.amount ?? held;
      // Số hoàn vượt phần treo là 400 (cùng mã với các route hoàn khác); `recordRefund` còn chặn vượt số đang giữ.
      if (amount > held) {
        throw new BadRequestException({
          code: ErrorCode.ORDER_REFUND_EXCEEDS_PAID,
          message: `A refund of ${amount} exceeds the undecided held money (${held})`,
          max: held,
          held,
        });
      }
      await recordRefund(tx, {
        order,
        amount,
        method: dto.method ?? (await this.defaultMethod(tx, id)),
        cap: 'HELD',
        actor: user,
        reason: 'HELD_DECISION',
        note: dto.note ?? null,
        description: `Hoàn tiền giữ treo đơn ${order.code}`,
        now,
      });
    });

    return this.reads.findOne(user, tenantId, id);
  }

  /** Cùng cách `resolveRefund`: hoàn bằng phương thức của khoản nhận gần nhất; SePay chỉ báo tiền vào nên hoàn bằng chuyển khoản. */
  private async defaultMethod(
    tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
    orderId: string,
  ): Promise<string> {
    const latest = await tx.payment.findFirst({
      where: {
        orderId,
        status: PaymentRecordStatus.PAID,
        kind: {
          in: [PaymentKind.DEPOSIT, PaymentKind.BALANCE, PaymentKind.FULL],
        },
      },
      orderBy: { createdAt: 'desc' },
      select: { method: true },
    });
    return !latest || latest.method === PaymentMethod.SEPAY
      ? PaymentMethod.BANK_TRANSFER
      : latest.method;
  }
}
