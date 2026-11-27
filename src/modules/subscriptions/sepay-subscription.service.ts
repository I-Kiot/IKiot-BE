import { Injectable } from '@nestjs/common';
import {
  generateReference,
  REFERENCE_PREFIX,
} from '../../common/utils/reference-generator';
import { normalizeAccountNumber } from '../../common/utils/bank-account';

// Thanh toán gói qua SePay vào tài khoản iKiot.
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

  /** Kiểm tài khoản nhận là của iKiot. */
  isPlatformAccount(payload: {
    accountNumber?: string | null;
    subAccount?: string | null;
  }): boolean {
    const own = normalizeAccountNumber(process.env.SEPAY_ACCOUNT_NUMBER);
    return (
      own !== '' &&
      [payload.accountNumber, payload.subAccount].some(
        (number) => normalizeAccountNumber(number) === own,
      )
    );
  }

  /** {6,10}: mã tạo trước khi generateReference chuẩn hoá 5 byte có 6 ký tự hex. */
  extractReference(content = ''): string | null {
    const match = content.match(/IKMS[0-9A-F]{6,10}/i);
    return match ? match[0].toUpperCase() : null;
  }
}
