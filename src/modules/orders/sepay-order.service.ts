import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  generateReference,
  REFERENCE_PREFIX,
} from '../../common/utils/reference-generator';
import { normalizeAccountNumber } from '../../common/utils/bank-account';

/** Separate from `SepaySubscriptionService`: that one pays iKiot's account from env vars, this one pays each shop's own. */
@Injectable()
export class SepayOrderService {
  private readonly logger = new Logger(SepayOrderService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Every order gets an `ORD` reference, not just SePay ones - the prefix is what makes a CashFlow row identifiable as sales revenue later. */
  generateOrderReference(): string {
    return generateReference(REFERENCE_PREFIX.ORDER);
  }

  /** `{6,10}` rather than `{10}`: references minted before the random space was widened are 6 hex characters and may still be PENDING. Greedy, so a current 10-character reference still matches in full. */
  extractOrderReference(content = ''): string | null {
    const match = content.match(/ORD[0-9A-F]{6,10}/i);
    return match ? match[0].toUpperCase() : null;
  }

  /** A per-shop key names the tenant; the shared key defers to the account in the payload. */
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

  /** `subAccount` too: a bank routing QR through a virtual account reports the VA there. If the two fields name different shops, refuse rather than credit the wrong one. */
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
