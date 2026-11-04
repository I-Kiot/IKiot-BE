import { Injectable } from '@nestjs/common';
import {
  generateReference,
  REFERENCE_PREFIX,
} from '../../common/utils/reference-generator';
import { normalizeAccountNumber } from '../../common/utils/bank-account';

// Port từ phần subscription của sepayService.js. Không dùng chung với thanh toán đơn hàng: gói này trả vào tài khoản công ty iKiot, còn đơn dùng thông tin ngân hàng và webhook key riêng của từng tenant.
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

  /** Tài khoản của các shop nằm chung trên SePay, nên nếu không kiểm tra thì shop có thể tự trả bằng nội dung `IKMS…` để kích hoạt gói. */
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
