import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InvoiceService } from '../invoices/invoices.service';
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
  PaymentMethod,
  PaymentRecordStatus,
} from '../../common/constants/payment-method';
import { FlowType } from '../stats/stats.constants';
import { writePaymentCashFlow } from './order-cash-flow';
import { ErrorCode } from '../../common/errors/error-codes';
import type { AuthUser } from '../../common/types/auth-user.type';

/**
 * `POST /orders/:id/confirm-remittance` (A-10): bước cuối khi đơn thu tiền lúc giao. Tiền shipper thu nằm ở Payment `BALANCE` PENDING (đang ở tay shipper). Chủ chỉ chốt khi nhận đủ; khi đó Payment thành RECEIVED và đơn COMPLETED. Nộp thiếu bị từ chối. Tiền vào sổ thu chi ở bước này, vì trước đó nó còn ở tay shipper.
 */
@Injectable()
export class OrderRemittanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrderService,
    private readonly reads: OrderReadService,
    private readonly invoices: InvoiceService,
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
        code: true,
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
    // Giao bằng QR cũng là RECEIVED, nhưng tiền đến qua webhook SePay chứ không qua shipper.
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
      // Chiếm đơn ở RECEIVED: trả hàng hoặc xác nhận lần hai xen giữa thì lần này thua trọn.
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
      await this.invoices.issueForOrder(tx, id, user.userId);
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
            // Ghi chú của người thu được giữ nguyên; ghi chú của chủ thêm vào bên dưới.
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
        await writePaymentCashFlow(tx, {
          tenantId,
          paymentId: payment.id,
          orderId: id,
          orderCode: order.code,
          flowType: FlowType.INCOME,
          amount: Number(payment.amount),
          method: PaymentMethod.CASH,
          locationId: order.branchId,
          createdById: user.userId,
          description: `Shipper nộp tiền đơn ${order.code}`,
        });
      }
    });

    return this.reads.findOne(user, tenantId, id);
  }
}
