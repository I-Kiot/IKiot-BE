import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { VIETNAM_TIMEZONE } from '../../common/constants/timezone';
import {
  PaymentKind,
  PaymentMethod,
  PaymentRecordStatus,
} from '../../common/constants/payment-method';
import { ChangeFeedService } from '../../common/realtime/change-feed.service';
import { OrderService } from './orders.service';
import { OrderChanges } from './orders.change-template';
import { isQrExpired, qrIssuedBefore } from './sepay-qr';

/**
 * Dọn mã QR SePay hết hạn, mỗi 5 phút:
 * (a) đơn quầy chờ QR quá hạn → CANCELLED, hàng về kho (nguồn sự kiện SYSTEM);
 * (b) khoản thu khi giao / tại quầy quá hạn → EXPIRED. Đơn giữ nguyên trạng thái, không có sự kiện: shipper còn tạo lại mã hay thu tiền mặt được.
 * Chạy được trên nhiều instance cùng lúc: mọi thay đổi đều là lệnh chiếm có điều kiện (còn PENDING), nên instance sau không làm gì thêm.
 * Giữa lúc hết hạn và lượt cron kế tiếp một khoản vẫn PENDING: mọi chỗ đọc phải dùng `isQrExpired`, không tin riêng status.
 */
@Injectable()
export class SepayQrExpiryCron {
  private readonly logger = new Logger(SepayQrExpiryCron.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrderService,
    private readonly changeFeed: ChangeFeedService,
  ) {}

  @Cron('*/5 * * * *', { timeZone: VIETNAM_TIMEZONE })
  async run(): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;
    try {
      const result = await this.expireStale();
      if (result.cancelledOrders > 0 || result.expiredPayments > 0) {
        this.logger.log(
          `QR expiry: ${result.cancelledOrders} POS order(s) cancelled, ${result.expiredPayments} payment(s) expired`,
        );
      }
    } catch (error) {
      this.logger.error(
        'QR expiry sweep failed',
        error instanceof Error ? error.stack : error,
      );
    }
  }

  /** Thân của lượt cron, public để test gọi thẳng với `now` giả. */
  async expireStale(
    now: Date = new Date(),
  ): Promise<{ cancelledOrders: number; expiredPayments: number }> {
    const cancelledOrders = await this.orders.cancelExpiredPosSales(now);

    const candidates = await this.prisma.payment.findMany({
      where: {
        method: PaymentMethod.SEPAY,
        kind: PaymentKind.BALANCE,
        status: PaymentRecordStatus.PENDING,
        OR: [
          { expiresAt: { lte: now } },
          { expiresAt: null, createdAt: { lte: qrIssuedBefore(now) } },
        ],
      },
      select: {
        id: true,
        expiresAt: true,
        createdAt: true,
        tenantId: true,
        orderId: true,
      },
      take: 500,
    });
    const due = candidates.filter((p) => isQrExpired(p, now));
    const ids = due.map((p) => p.id);
    if (ids.length === 0) return { cancelledOrders, expiredPayments: 0 };

    const expired = await this.prisma.payment.updateMany({
      where: { id: { in: ids }, status: PaymentRecordStatus.PENDING },
      data: { status: PaymentRecordStatus.EXPIRED },
    });
    // Một sự kiện gộp (không toast) cho mỗi tenant: màn hình đang mở mã QR chỉ cần tải lại.
    const orderIdsByTenant = new Map<string, string[]>();
    for (const payment of due) {
      const list = orderIdsByTenant.get(payment.tenantId) ?? [];
      list.push(payment.orderId);
      orderIdsByTenant.set(payment.tenantId, list);
    }
    for (const [tenantId, orderIds] of orderIdsByTenant) {
      this.changeFeed.publish({
        tenantId,
        spec: OrderChanges.paymentQrExpired,
        target: { subjectId: null, code: null, related: { orders: orderIds } },
        actor: { source: 'SYSTEM' },
      });
    }
    return { cancelledOrders, expiredPayments: expired.count };
  }
}
