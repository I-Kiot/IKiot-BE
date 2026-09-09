import { Injectable } from '@nestjs/common';
import {
  generateReference,
  REFERENCE_PREFIX,
} from '../../common/utils/reference-generator';

// Ported from the subscription half of sepayService.js and deliberately not shared with order payments: this one pays into iKiot's own company account, while orders use each tenant's banking fields and a per-tenant webhook key.
@Injectable()
export class SepaySubscriptionService {
  generatePaymentReference(): string {
    return generateReference(REFERENCE_PREFIX.SUBSCRIPTION);
  }

  buildQrUrl(amount: number, paymentReference: string): string {
    const accountNumber = process.env.SEPAY_ACCOUNT_NUMBER ?? '';
    const bankName = process.env.SEPAY_BANK_NAME ?? '';
    const accountName = process.env.SEPAY_ACCOUNT_NAME ?? '';
    return (
      `https://img.vietqr.io/image/${bankName}-${accountNumber}-compact2.png` +
      `?amount=${amount}&addInfo=${encodeURIComponent(paymentReference)}&accountName=${encodeURIComponent(accountName)}`
    );
  }

  verifyWebhookKey(receivedKey: string): boolean {
    const expectedKey = process.env.SEPAY_WEBHOOK_API_KEY ?? '';
    return Boolean(expectedKey) && receivedKey === expectedKey;
  }

  /** {6,10}: refs minted before generateReference standardised on 5 bytes are 6 hex. */
  extractReference(content = ''): string | null {
    const match = content.match(/IKMS[0-9A-F]{6,10}/i);
    return match ? match[0].toUpperCase() : null;
  }
}
