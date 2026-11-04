import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  generateReference,
  REFERENCE_PREFIX,
} from '../../common/utils/reference-generator';
import { normalizeAccountNumber } from '../../common/utils/bank-account';

/** Tách khỏi `SepaySubscriptionService`: service kia thu vào tài khoản iKiot lấy từ env, service này thu vào tài khoản riêng của từng shop. */
@Injectable()
export class SepayOrderService {
  private readonly logger = new Logger(SepayOrderService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Mọi đơn đều có mã `ORD`, không chỉ đơn SePay; tiền tố này giúp nhận ra dòng CashFlow là doanh thu bán hàng. */
  generateOrderReference(): string {
    return generateReference(REFERENCE_PREFIX.ORDER);
  }

  /** `{6,10}` thay vì `{10}`: mã tạo trước khi nới không gian ngẫu nhiên dài 6 ký tự hex và có thể còn PENDING. Tham lam nên mã 10 ký tự hiện tại vẫn khớp đủ. */
  extractOrderReference(content = ''): string | null {
    const match = content.match(/ORD[0-9A-F]{6,10}/i);
    return match ? match[0].toUpperCase() : null;
  }

  /** Key riêng của shop xác định tenant; key dùng chung thì nhường cho tài khoản trong payload. */
  async resolveTenant(apiKey: string, payload: Record<string, unknown>) {
    if (!apiKey) return null;
    const sharedKey = process.env.SEPAY_ORDER_WEBHOOK_API_KEY?.trim();
    if (sharedKey && apiKey === sharedKey) {
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

  /** `subAccount` cũng vậy: ngân hàng đi qua tài khoản ảo báo VA ở đó. Nếu hai trường trỏ tới hai shop khác nhau thì từ chối, không ghi có nhầm shop. */
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
