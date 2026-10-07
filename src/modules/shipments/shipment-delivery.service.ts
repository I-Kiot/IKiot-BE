import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationService } from '../notifications/notifications.service';
import { OrderNotificationTemplates } from '../notifications/templates/order.templates';
import { requireTenantBanking } from '../orders/tenant-banking';
import { DeliverShipmentDto } from './dto/deliver-shipment.dto';
import { PayCashDto } from './dto/pay-cash.dto';
import {
  amountDueOf,
  loadShipmentDetail,
  SHIPMENT_SUMMARY_INCLUDE,
  toSummary,
} from './shipment-view';
import {
  deliveryActorAccess,
  ON_THE_ROAD_STATUSES,
  onTheRoadWhere,
} from './shipment-actor';
import {
  OrderPaymentStatus,
  OrderStatus,
  RemittanceStatus,
} from '../../common/constants/order-status';
import {
  DeliveryCollectionMethod,
  PaymentKind,
  PaymentMethod,
  PaymentRecordStatus,
} from '../../common/constants/payment-method';
import {
  CarrierType,
  FINAL_SHIPMENT_STATUSES,
  ShipmentEventSource,
  ShipmentStatus,
} from '../../common/constants/shipment-status';
import { ErrorCode } from '../../common/errors/error-codes';
import {
  generateReference,
  REFERENCE_PREFIX,
} from '../../common/utils/reference-generator';
import type { AuthUser } from '../../common/types/auth-user.type';

/** Phần của lần giao mà giao xong / thu tiền cần đọc. */
const DELIVERY_SELECT = {
  id: true,
  status: true,
  carrierType: true,
  driverId: true,
  fulfillment: { select: { locationId: true } },
  order: {
    select: {
      id: true,
      code: true,
      status: true,
      assigneeId: true,
      branchId: true,
      grandTotal: true,
      depositAmount: true,
    },
  },
} as const;

/**
 * Giao xong và thu tiền khi giao (C-5, chốt 2026-10-06), cho lần giao **nội bộ** (shipper / thợ của shop):
 *
 * - Đã cọc đủ → đơn COMPLETED.
 * - Tiền mặt → đơn RECEIVED, khoản CASH đã thu nhưng tiền đang ở tay shipper (`remittanceStatus` PENDING)
 *   cho tới khi chủ xác nhận (A-10).
 * - QR → đơn RECEIVED, khoản SEPAY **chờ tiền về**; webhook SePay báo đủ tiền thì đơn COMPLETED. Khách
 *   không chuyển thì shipper bấm "khách trả tiền mặt" (`payCash`) và đi đường tiền mặt.
 * - Chuyển thiếu: **chưa xử lý** (nhóm còn họp) – webhook chỉ ghi log, khoản vẫn chờ.
 *
 * Lần giao qua ĐVVC ngoài không đi qua đây: hãng tự báo về (C-4, Phase 2).
 *
 * Không ghi `CashFlow` – việc đó của E-5, như khoản cọc của A-2.
 */
@Injectable()
export class ShipmentDeliveryService {
  private readonly logger = new Logger(ShipmentDeliveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
  ) {}

  // ─── Đơn cần giao của tôi ───────────────────────────────────────────────────

  /** GET /shipments/mine: các lần giao chưa kết thúc mà người gọi là shipper, ngày hẹn gần nhất trước. */
  async listMine(user: AuthUser, tenantId: string) {
    const rows = await this.prisma.shipment.findMany({
      where: {
        tenantId,
        driverId: user.userId,
        status: { notIn: [...FINAL_SHIPMENT_STATUSES] },
      },
      include: SHIPMENT_SUMMARY_INCLUDE,
      orderBy: [
        { scheduledDate: { sort: 'asc', nulls: 'last' } },
        { createdAt: 'asc' },
      ],
    });
    return rows.map(toSummary);
  }

  // ─── Giao xong ──────────────────────────────────────────────────────────────

  /** POST /shipments/:id/deliver: shipper xác nhận đã giao thành công, kèm ảnh bằng chứng và cách thu tiền. */
  async deliver(
    user: AuthUser,
    tenantId: string,
    id: string,
    dto: DeliverShipmentDto,
  ) {
    const shipment = await this.loadShipment(tenantId, id);
    const access = deliveryActorAccess(user, shipment);

    // Các kiểm tra dưới đây chỉ để báo lỗi rõ ràng sớm; chỗ chặn thật là các câu ghi có điều kiện trong transaction.
    if (shipment.carrierType !== CarrierType.INTERNAL) {
      throw new BadRequestException({
        code: ErrorCode.SHIPMENT_DELIVER_INTERNAL_ONLY,
        message:
          'Only our own shippers confirm a delivery; a carrier reports its own',
      });
    }
    if (shipment.order.status !== OrderStatus.SHIPPING) {
      throw new ConflictException({
        code: ErrorCode.SHIPMENT_ORDER_NOT_SHIPPING,
        message: `The order is ${shipment.order.status}, not on its way`,
      });
    }
    if (!ON_THE_ROAD_STATUSES.includes(shipment.status)) {
      throw new ConflictException({
        code: ErrorCode.SHIPMENT_STATUS_INVALID,
        message: `A ${shipment.status} shipment cannot be delivered`,
      });
    }
    if (dto.proofPhotoUrls.length === 0) {
      throw new BadRequestException({
        code: ErrorCode.SHIPMENT_PROOF_REQUIRED,
        message: 'A delivery needs at least one proof photo',
      });
    }

    const amountDue = amountDueOf(shipment.order);
    assertCollectionMatches(amountDue, dto.paymentMethod, dto.collectedAmount);

    const method = dto.paymentMethod;
    if (method === DeliveryCollectionMethod.BANK_TRANSFER_QR) {
      // Không có tài khoản nhận tiền thì không dựng được mã QR cho khách quét.
      await requireTenantBanking(this.prisma, tenantId);
    }

    // Đã cọc đủ thì xong luôn; tiền mặt chờ chủ nhận tiền, QR chờ tiền về.
    const nextOrderStatus =
      method === DeliveryCollectionMethod.NONE
        ? OrderStatus.COMPLETED
        : OrderStatus.RECEIVED;

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      // 1. Nhận lần giao: vẫn đang trên đường, và người bấm vẫn là shipper / người phụ trách.
      const claimed = await tx.shipment.updateMany({
        where: onTheRoadWhere(id, access, user),
        data: {
          status: ShipmentStatus.DELIVERED,
          deliveredAt: now,
          proofPhotoUrls: dto.proofPhotoUrls,
        },
      });
      if (claimed.count !== 1) {
        throw new ConflictException({
          code: ErrorCode.SHIPMENT_STATUS_INVALID,
          message: 'The shipment has just changed, please reload',
        });
      }
      await tx.shipmentEvent.create({
        data: {
          shipmentId: id,
          status: ShipmentStatus.DELIVERED,
          source: ShipmentEventSource.MANUAL,
          note: dto.note ?? null,
          latitude: dto.latitude ?? null,
          longitude: dto.longitude ?? null,
          createdById: user.userId,
        },
      });

      // 2. Đơn đi tiếp. Tiền mặt nghĩa là khách đã trả đủ, dù tiền còn ở tay shipper.
      const orderData: { status: string; paymentStatus?: string } = {
        status: nextOrderStatus,
      };
      if (method === DeliveryCollectionMethod.CASH) {
        orderData.paymentStatus = OrderPaymentStatus.PAID;
      }
      const orderClaimed = await tx.order.updateMany({
        where: {
          id: shipment.order.id,
          tenantId,
          status: OrderStatus.SHIPPING,
        },
        data: orderData,
      });
      if (orderClaimed.count !== 1) {
        throw new ConflictException({
          code: ErrorCode.ORDER_STATUS_CONFLICT,
          message: 'The order has just changed, please reload',
        });
      }

      // 3. Khoản thu khi giao.
      if (method === DeliveryCollectionMethod.CASH) {
        await tx.payment.create({
          data: {
            tenantId,
            orderId: shipment.order.id,
            kind: PaymentKind.BALANCE,
            method: PaymentMethod.CASH,
            amount: amountDue,
            status: PaymentRecordStatus.PAID,
            paidAt: now,
            locationId: shipment.order.branchId,
            collectedById: user.userId,
            remittanceStatus: RemittanceStatus.PENDING,
            createdById: user.userId,
            note: dto.note ?? null,
          },
        });
      }
      if (method === DeliveryCollectionMethod.BANK_TRANSFER_QR) {
        // Mã ORD… mới làm nội dung chuyển khoản – webhook SePay nhận ra khoản này nhờ nó.
        await tx.payment.create({
          data: {
            tenantId,
            orderId: shipment.order.id,
            kind: PaymentKind.BALANCE,
            method: PaymentMethod.SEPAY,
            amount: amountDue,
            status: PaymentRecordStatus.PENDING,
            paymentReference: generateReference(REFERENCE_PREFIX.ORDER),
            locationId: shipment.order.branchId,
            collectedById: user.userId,
            createdById: user.userId,
            note: dto.note ?? null,
          },
        });
      }
    });

    // Sau commit: transaction rollback thì không có thông báo nào.
    if (method === DeliveryCollectionMethod.CASH) {
      await this.notifyCashHeld(tenantId, shipment.order, amountDue);
    }
    // Có khoản QR thì chi tiết trả kèm `payment.qrUrl` để shipper đưa khách quét.
    return loadShipmentDetail(this.prisma, tenantId, id);
  }

  // ─── Khách không chuyển khoản ───────────────────────────────────────────────

  /**
   * POST /shipments/:id/pay-cash: đã giao với QR nhưng khách không chuyển – shipper thu tiền mặt thay.
   * Khoản QR đang chờ bị huỷ, ghi khoản tiền mặt (chờ nộp lại cho chủ); đơn giữ RECEIVED.
   */
  async payCash(user: AuthUser, tenantId: string, id: string, dto: PayCashDto) {
    const shipment = await this.loadShipment(tenantId, id);
    const access = deliveryActorAccess(user, shipment);

    const qrPayment = await this.prisma.payment.findFirst({
      where: {
        tenantId,
        orderId: shipment.order.id,
        kind: PaymentKind.BALANCE,
        method: PaymentMethod.SEPAY,
        status: PaymentRecordStatus.PENDING,
      },
      select: { id: true, amount: true },
    });
    if (!qrPayment) {
      throw new ConflictException({
        code: ErrorCode.ORDER_QR_PAYMENT_NOT_PENDING,
        message: 'There is no QR payment waiting for its transfer',
      });
    }

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      // 1. Huỷ khoản QR – chỉ khi vẫn đang chờ. Tiền vừa về (webhook thắng) thì dừng ở đây.
      const cancelled = await tx.payment.updateMany({
        where: { id: qrPayment.id, status: PaymentRecordStatus.PENDING },
        data: { status: PaymentRecordStatus.CANCELLED },
      });
      if (cancelled.count !== 1) {
        throw new ConflictException({
          code: ErrorCode.ORDER_QR_PAYMENT_NOT_PENDING,
          message: 'The transfer has just arrived, please reload',
        });
      }

      // 2. Đơn vẫn chờ tiền (RECEIVED) và người bấm vẫn phụ trách đơn, nếu nhờ đó mà được phép.
      const orderWhere: {
        id: string;
        tenantId: string;
        status: string;
        assigneeId?: string;
      } = { id: shipment.order.id, tenantId, status: OrderStatus.RECEIVED };
      if (access === 'ASSIGNEE') {
        orderWhere.assigneeId = user.userId;
      }
      const orderClaimed = await tx.order.updateMany({
        where: orderWhere,
        data: { paymentStatus: OrderPaymentStatus.PAID },
      });
      if (orderClaimed.count !== 1) {
        throw new ConflictException({
          code: ErrorCode.ORDER_STATUS_CONFLICT,
          message: 'The order has just changed, please reload',
        });
      }

      // 3. Khoản tiền mặt thay cho khoản QR.
      await tx.payment.create({
        data: {
          tenantId,
          orderId: shipment.order.id,
          kind: PaymentKind.BALANCE,
          method: PaymentMethod.CASH,
          amount: qrPayment.amount,
          status: PaymentRecordStatus.PAID,
          paidAt: now,
          locationId: shipment.order.branchId,
          collectedById: user.userId,
          remittanceStatus: RemittanceStatus.PENDING,
          createdById: user.userId,
          note: dto.note ?? null,
        },
      });
    });

    await this.notifyCashHeld(
      tenantId,
      shipment.order,
      Number(qrPayment.amount),
    );
    return loadShipmentDetail(this.prisma, tenantId, id);
  }

  // ─── Webhook SePay ──────────────────────────────────────────────────────────

  /**
   * Tiền chuyển khoản QR lúc giao đã về (gọi từ webhook SePay khi nhánh bán tại quầy không khớp). Trả về
   * `true` nếu mã thuộc một khoản thu khi giao (đã xử lý xong, kể cả khi chỉ ghi log), `false` nếu không.
   * Không bao giờ ném lỗi về webhook – SePay gọi lại mọi câu trả lời khác 200.
   */
  async settleSepayBalance(
    tenantId: string,
    paymentReference: string,
    sepayTransactionId: string | null,
    transferAmount: number,
  ): Promise<boolean> {
    const payment = await this.prisma.payment.findFirst({
      where: {
        tenantId,
        paymentReference,
        kind: PaymentKind.BALANCE,
        method: PaymentMethod.SEPAY,
      },
      select: {
        id: true,
        amount: true,
        status: true,
        order: { select: { id: true, code: true, assigneeId: true } },
      },
    });
    if (!payment) return false;

    if (payment.status === PaymentRecordStatus.PAID) {
      // SePay gọi lại cùng một giao dịch – đã xử lý rồi.
      return true;
    }
    if (payment.status === PaymentRecordStatus.CANCELLED) {
      this.logger.warn(
        `SePay transfer ${sepayTransactionId ?? '(no id)'} (${transferAmount}) for ${paymentReference} arrived after the ` +
          `shipper switched order ${payment.order.code} to cash - the customer may have paid twice. Manual refund may be required.`,
      );
      return true;
    }

    const amount = Number(payment.amount);
    if (transferAmount < amount) {
      // Chuyển thiếu: chờ nhóm chốt cách xử lý – khoản vẫn chờ, chỉ ghi log để người xử lý thấy.
      this.logger.warn(
        `SePay transfer ${sepayTransactionId ?? '(no id)'} for ${paymentReference} is short: ${amount} due, ` +
          `${transferAmount} received. Order ${payment.order.code} left waiting - short transfers are not handled yet.`,
      );
      return true;
    }

    const now = new Date();
    const settled = await this.prisma.$transaction(async (tx) => {
      // Chỉ từ PENDING: webhook lặp lại, hay "khách trả tiền mặt" vừa thắng, thì không ghi gì.
      const paid = await tx.payment.updateMany({
        where: { id: payment.id, status: PaymentRecordStatus.PENDING },
        data: {
          status: PaymentRecordStatus.PAID,
          paidAt: now,
          sepayTransactionId,
        },
      });
      if (paid.count !== 1) return false;

      const completed = await tx.order.updateMany({
        where: { id: payment.order.id, status: OrderStatus.RECEIVED },
        data: {
          status: OrderStatus.COMPLETED,
          paymentStatus: OrderPaymentStatus.PAID,
        },
      });
      if (completed.count !== 1) {
        this.logger.warn(
          `SePay transfer for ${paymentReference} was recorded, but order ${payment.order.code} is no longer RECEIVED and was not completed.`,
        );
      }
      return true;
    });

    if (settled && payment.order.assigneeId) {
      await this.notifications.notify({
        tenantId,
        recipientIds: [payment.order.assigneeId],
        referenceId: payment.order.id,
        ...OrderNotificationTemplates.deliveryTransferReceived(
          payment.order.code,
          transferAmount,
        ),
      });
    }
    return true;
  }

  // ─── Nội bộ ─────────────────────────────────────────────────────────────────

  /** Nạp lần giao cùng đơn của nó; không có trong shop thì 404. */
  private async loadShipment(tenantId: string, id: string) {
    const shipment = await this.prisma.shipment.findFirst({
      where: { id, tenantId },
      select: DELIVERY_SELECT,
    });
    if (!shipment) {
      throw new NotFoundException({
        code: ErrorCode.SHIPMENT_NOT_FOUND,
        message: 'Shipment not found',
      });
    }
    return shipment;
  }

  /** Báo người phụ trách và chủ shop: shipper đang giữ tiền mặt, chờ nộp lại (A-10). Không bao giờ ném lỗi. */
  private async notifyCashHeld(
    tenantId: string,
    order: { id: string; code: string; assigneeId: string | null },
    amount: number,
  ) {
    const owners = await this.notifications.tenantOwners(tenantId);
    await this.notifications.notify({
      tenantId,
      recipientIds: [order.assigneeId, ...owners],
      referenceId: order.id,
      ...OrderNotificationTemplates.cashAwaitingRemittance(
        order.id,
        order.code,
        amount,
      ),
    });
  }
}

/**
 * Số tiền shipper thu phải khớp đúng số còn phải thu (chốt 2026-10-06: chỉ xử lý thu đủ 100%).
 * - Không còn gì phải thu → chỉ chấp nhận `NONE`, số thu 0.
 * - Còn tiền phải thu → không được `NONE`, và số thu phải bằng đúng số còn phải thu.
 */
function assertCollectionMatches(
  amountDue: number,
  method: string,
  collectedAmount: number,
): void {
  if (amountDue === 0) {
    if (method !== DeliveryCollectionMethod.NONE || collectedAmount !== 0) {
      throw new BadRequestException({
        code: ErrorCode.ORDER_COLLECTION_AMOUNT_MISMATCH,
        message: 'Nothing is left to collect on this order',
      });
    }
    return;
  }
  if (method === DeliveryCollectionMethod.NONE) {
    throw new BadRequestException({
      code: ErrorCode.ORDER_COLLECTION_AMOUNT_MISMATCH,
      message: `${amountDue} is still due on this order`,
    });
  }
  if (collectedAmount !== amountDue) {
    throw new BadRequestException({
      code: ErrorCode.ORDER_COLLECTION_AMOUNT_MISMATCH,
      message: `Collected ${collectedAmount}, but ${amountDue} is due`,
    });
  }
}
