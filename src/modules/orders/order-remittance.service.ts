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
import { assertTransition } from './order-status';
import { ConfirmRemittanceDto } from './dto/confirm-remittance.dto';
import {
  OrderStatus,
  RemittanceStatus,
} from '../../common/constants/order-status';
import {
  PaymentKind,
  PaymentRecordStatus,
} from '../../common/constants/payment-method';
import { ErrorCode } from '../../common/errors/error-codes';
import type { AuthUser } from '../../common/types/auth-user.type';

/**
 * `POST /orders/:id/confirm-remittance` (A-10, contract §2 and §4): the last step of a cash delivery.
 * Delivery (C-5) left the order RECEIVED with the cash it collected as a `BALANCE` payment whose
 * `remittanceStatus` is PENDING - the money is in the shipper's hands. The owner (`orders:confirm_cash`)
 * counts what was handed back; only the full amount settles it (contract: the owner must receive all
 * of it), and then the payment is RECEIVED and the order COMPLETED. A short hand-over is refused and
 * stays visible as pending - how a shortfall is booked is not decided yet. No `CashFlow` row is
 * written here: that is E-5's, as for every other payment of the journey.
 */
@Injectable()
export class OrderRemittanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrderService,
    private readonly reads: OrderReadService,
  ) {}

  async confirm(
    user: AuthUser,
    tenantId: string,
    id: string,
    dto: ConfirmRemittanceDto,
  ) {
    const order = await this.prisma.order.findFirst({
      where: { id, tenantId },
      select: {
        id: true,
        branchId: true,
        status: true,
        payments: {
          where: {
            kind: PaymentKind.BALANCE,
            status: PaymentRecordStatus.PAID,
            remittanceStatus: RemittanceStatus.PENDING,
          },
          select: { id: true, amount: true, note: true },
        },
      },
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
    // A QR delivery is RECEIVED too, but its money comes through the SePay webhook, not a shipper.
    if (order.status !== OrderStatus.RECEIVED || order.payments.length === 0) {
      throw new ConflictException({
        code: ErrorCode.ORDER_REMITTANCE_NOT_PENDING,
        message:
          'No cash collected for this order is waiting to be handed back',
      });
    }
    assertTransition(order.status, OrderStatus.COMPLETED);

    const held = order.payments.reduce((sum, p) => sum + Number(p.amount), 0);
    const amount = Math.round(dto.amount);
    if (amount !== held) {
      throw new BadRequestException({
        code: ErrorCode.ORDER_REMITTANCE_AMOUNT_MISMATCH,
        message: `The shipper collected ${held}, not ${amount}`,
        remittance: { held, amount, difference: amount - held },
      });
    }

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      // Claimed on RECEIVED: a return or a second confirmation in between loses this one whole.
      const claimed = await tx.order.updateMany({
        where: { id, tenantId, status: OrderStatus.RECEIVED },
        data: { status: OrderStatus.COMPLETED },
      });
      if (claimed.count !== 1) {
        throw new ConflictException({
          code: ErrorCode.ORDER_STATUS_CONFLICT,
          message: 'The order status has just changed, please reload',
        });
      }
      for (const payment of order.payments) {
        const settled = await tx.payment.updateMany({
          where: {
            id: payment.id,
            remittanceStatus: RemittanceStatus.PENDING,
          },
          data: {
            remittanceStatus: RemittanceStatus.RECEIVED,
            remittanceConfirmedById: user.userId,
            remittanceConfirmedAt: now,
            // The collector's own note is kept; the owner's is added under it.
            ...(dto.note
              ? {
                  note: payment.note
                    ? `${payment.note}\n${dto.note}`
                    : dto.note,
                }
              : {}),
          },
        });
        if (settled.count !== 1) {
          throw new ConflictException({
            code: ErrorCode.ORDER_STATUS_CONFLICT,
            message: 'The payment has just changed, please reload',
          });
        }
      }
    });

    return this.reads.findOne(user, tenantId, id);
  }
}
