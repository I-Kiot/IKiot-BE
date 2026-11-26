import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  generateReference,
  REFERENCE_PREFIX,
} from '../../common/utils/reference-generator';
import { normalizeAccountNumber } from '../../common/utils/bank-account';
import { NotificationService } from '../notifications/notifications.service';
import { SepayRejectReason } from '../../common/constants/payment-method';
import { recordUnmatchedTransfer, type SepayTransfer } from './sepay-qr';

/** Thanh toán SePay vào tài khoản riêng của từng shop. */
@Injectable()
export class SepayOrderService {
  private readonly logger = new Logger(SepayOrderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
  ) {}

  /** Tiền tố mã thanh toán của đơn. */
  generateOrderReference(): string {
    return generateReference(REFERENCE_PREFIX.ORDER);
  }

  /** Khớp mã dài 6 đến 10 ký tự (gồm mã cũ). */
  extractOrderReference(content = ''): string | null {
    const match = content.match(/ORD[0-9A-F]{6,10}/i);
    return match ? match[0].toUpperCase() : null;
  }

  /** Webhook đang dùng key dùng chung của nền tảng (chứ không phải key riêng của một shop). */
  isSharedKey(apiKey: string): boolean {
    const sharedKey = process.env.SEPAY_ORDER_WEBHOOK_API_KEY?.trim();
    return !!sharedKey && apiKey === sharedKey;
  }

  /** Ghi sổ tiền về không gắn được đơn. */
  recordUnmatched(
    tenantId: string | null,
    transfer: SepayTransfer,
    reference: string | null,
    reason: SepayRejectReason,
  ) {
    return recordUnmatchedTransfer(
      this.prisma,
      this.notifications,
      this.logger,
      {
        tenantId,
        transfer,
        paymentReference: reference,
        reason,
      },
    );
  }

  /** Key riêng của shop xác định tenant; key dùng chung thì nhường cho tài khoản trong payload. */
  async resolveTenant(apiKey: string, payload: Record<string, unknown>) {
    if (!apiKey) return null;
    if (this.isSharedKey(apiKey)) {
      return this.findTenantByAccount(payload);
    }
    return this.findTenantByWebhookKey(apiKey);
  }

  async findTenantByWebhookKey(apiKey: string) {
    if (!apiKey) return null;
    return this.prisma.tenant.findFirst({
      where: { bankingSepayWebhookApiKey: apiKey },
      select: { id: true },
    });
  }

  /** Lấy shop theo tài khoản nhận hoặc tài khoản ảo. */
  private async findTenantByAccount(payload: Record<string, unknown>) {
    const numbers = [payload.accountNumber, payload.subAccount]
      .map((value) => (typeof value === 'string' ? value : ''))
      .map(normalizeAccountNumber)
      .filter(Boolean);
    if (numbers.length === 0) return null;

    const tenants = await this.prisma.tenant.findMany({
      where: { bankingAccountNumber: { in: numbers } },
      select: { id: true },
      take: 2,
    });
    if (tenants.length > 1) {
      this.logger.error(
        `SePay transfer ${String(payload.id)} names accounts of two shops (${numbers.join('/')}) - not settled.`,
      );
      return null;
    }
    return tenants[0] ?? null;
  }
}
