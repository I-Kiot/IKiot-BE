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
import { assertTransition, nextStatusAfterPayment } from './order-status';
import { syncOrderPaymentStatus } from './payment-status';
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
import { CashFlowCategory } from '../../common/constants/cash-flow-category';
import { writePaymentCashFlow } from './order-cash-flow';
import { lockOrder } from './order-lock';
import { completedData } from './order-status';
import { postSale } from './sales-journal';
import { SalesJournalSource } from '../../common/constants/sales-journal';
import { sumDong, toDong } from '../../common/utils/money';
import { ErrorCode } from '../../common/errors/error-codes';
import type { AuthUser } from '../../common/types/auth-user.type';
import { OrderEventType } from '../../common/constants/order-event-type';
import { recordOrderEvent, userActor } from './order-events';

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
        fulfillmentType: true,
        payments: {
          where: {
            kind: PaymentKind.BALANCE,
            status: PaymentRecordStatus.PAID,
            remittanceStatus: RemittanceStatus.PENDING,
          },
          select: { id: true, amount: true, method: true },
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
    // Giao bằng QR cũng là RECEIVED, nhưng tiền đến qua webhook SePay chứ không qua shipper. Đơn đã RETURNED (giao xong rồi khách trả hàng khi tiền mặt còn ở tay shipper) vẫn nhận được tiền shipper nộp: tiền đã thu thật, chỉ không còn đơn nào để hoàn thành (quyết định 4, 2026-11-11).
    const accepting: readonly string[] = [
      OrderStatus.RECEIVED,
      OrderStatus.RETURNED,
    ];
    if (!accepting.includes(order.status) || order.payments.length === 0) {
      throw new ConflictException({
        code: ErrorCode.ORDER_REMITTANCE_NOT_PENDING,
        message:
          'No cash collected for this order is waiting to be handed back',
      });
    }

    const held = sumDong(order.payments.map((p) => p.amount));
    const amount = toDong(dto.amount);
    if (amount !== held) {
      throw new BadRequestException({
        code: ErrorCode.ORDER_REMITTANCE_AMOUNT_MISMATCH,
        message: `The shipper collected ${held}, not ${amount}`,
        remittance: { held, amount, difference: amount - held },
      });
    }

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      // Khoá đơn trước: xác nhận hai lần cùng lúc xếp hàng ở đây, lần sau thua ở lệnh chiếm khoản bên dưới (khoản không còn PENDING).
      await lockOrder(tx, tenantId, id);
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
            // Lời người thu (`note`) không bị sửa; ghi chú của chủ có cột riêng.
            ...(dto.note ? { remittanceNote: dto.note } : {}),
          },
        });
        if (settled.count !== 1) {
          throw new ConflictException({
            code: ErrorCode.ORDER_STATUS_CONFLICT,
            message: 'The payment has just changed, please reload',
          });
        }
        // Shipper nộp thẳng cho chủ shop, không qua két nào: quỹ OWNER, `locationId` chỉ để quy về chi nhánh của đơn.
        await writePaymentCashFlow(tx, {
          tenantId,
          payment,
          category: CashFlowCategory.ORDER_PAYMENT,
          orderId: id,
          orderCode: order.code,
          locationId: order.branchId,
          createdById: user.userId,
          handedToOwner: true,
          description: `Shipper nộp tiền đơn ${order.code}`,
        });
      }

      // Các khoản đã được chiếm: trạng thái thanh toán suy ra, rồi `nextStatusAfterPayment` quyết định đơn có hoàn thành không (RECEIVED, đủ tiền, hết tiền shipper đang giữ). Đơn RETURNED hay chưa đủ tiền thì giữ nguyên.
      const derived = await syncOrderPaymentStatus(tx, id);
      const stillHeld =
        (await tx.payment.count({
          where: {
            orderId: id,
            status: PaymentRecordStatus.PAID,
            remittanceStatus: RemittanceStatus.PENDING,
          },
        })) > 0;
      const next = nextStatusAfterPayment(order, derived, stillHeld);
      if (next === OrderStatus.COMPLETED) {
        assertTransition(order.status, OrderStatus.COMPLETED);
        // Chiếm đơn ở RECEIVED: trả hàng xen giữa thì lần này thua trọn.
        const claimed = await tx.order.updateMany({
          where: { id, tenantId, status: OrderStatus.RECEIVED },
          data: completedData(now),
        });
        if (claimed.count !== 1) {
          throw new ConflictException({
            code: ErrorCode.ORDER_STATUS_CONFLICT,
            message: 'The order status has just changed, please reload',
          });
        }
        await postSale(tx, {
          orderId: id,
          actor: { id: user.userId },
          now,
          source: SalesJournalSource.REMITTANCE,
        });
        await this.invoices.issueForOrder(tx, id, user.userId);
      }
      await recordOrderEvent(tx, userActor(user), {
        tenantId,
        orderId: id,
        type: OrderEventType.REMITTANCE_CONFIRMED,
        fromStatus: next ? order.status : null,
        toStatus: next,
        metadata: { amount, method: PaymentMethod.CASH },
      });
    });

    return this.reads.findOne(user, tenantId, id);
  }
}
