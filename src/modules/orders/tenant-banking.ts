import { BadRequestException } from '@nestjs/common';
import { ErrorCode } from '../../common/errors/error-codes';
import type { PrismaService } from '../../prisma/prisma.service';
import { isSepayLinked } from '../tenants/tenant-select';

// Tài khoản ngân hàng của shop cho thanh toán SePay / VietQR: một chỗ duy nhất cho cả bán tại quầy
// (OrderService) lẫn thu tiền khi giao (ShipmentDeliveryService). Là hàm thuần, không phải service, vì
// module orders đã import module shipments – đặt trong một service của orders thì shipments không gọi
// ngược lại được.

export interface TenantBanking {
  bankingBankName: string | null;
  bankingAccountNumber: string | null;
  bankingAccountName: string | null;
}

/** Trước khi phát QR: có tài khoản nhận tiền, và đã liên kết SePay - nếu không khách chuyển được tiền nhưng không webhook nào báo về, đơn nằm chờ mãi. */
export async function requireTenantBanking(
  prisma: Pick<PrismaService, 'tenant'>,
  tenantId: string,
): Promise<TenantBanking> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: {
      bankingBankName: true,
      bankingAccountNumber: true,
      bankingAccountName: true,
      bankingSepayWebhookApiKey: true,
      bankingSepayLinkedAt: true,
    },
  });
  if (!tenant?.bankingAccountNumber || !tenant.bankingBankName) {
    throw new BadRequestException({
      code: ErrorCode.TENANT_BANKING_NOT_CONFIGURED,
      message:
        'This shop has not configured its bank details for SePay payments',
    });
  }
  if (!isSepayLinked(tenant)) {
    throw new BadRequestException({
      code: ErrorCode.TENANT_SEPAY_NOT_LINKED,
      message: "This shop's bank account is not linked to SePay yet",
    });
  }
  return {
    bankingBankName: tenant.bankingBankName,
    bankingAccountNumber: tenant.bankingAccountNumber,
    bankingAccountName: tenant.bankingAccountName,
  };
}

/** Tên, mã VietQR, mã chứng khoán và BIN của VietinBank. */
const VIETINBANK_NAMES = new Set(['VIETINBANK', 'ICB', 'CTG', '970415']);

/** VietinBank chỉ cho SePay đọc giao dịch có `SEVQR` trong nội dung. */
export function transferContent(
  bankName: string | null,
  paymentReference: string,
): string {
  const bank = (bankName ?? '').replace(/\s+/g, '').toUpperCase();
  return VIETINBANK_NAMES.has(bank)
    ? `SEVQR ${paymentReference}`
    : paymentReference;
}

/** Link ảnh VietQR: khách quét là chuyển đúng số tiền, nội dung là mã thanh toán để webhook SePay nhận ra. */
export function buildSepayQrUrl(
  banking: TenantBanking,
  amount: number,
  paymentReference: string,
): string {
  const bankName = banking.bankingBankName ?? '';
  const accountNumber = banking.bankingAccountNumber ?? '';
  const accountName = banking.bankingAccountName ?? '';
  const content = transferContent(banking.bankingBankName, paymentReference);
  return (
    `https://img.vietqr.io/image/${bankName}-${accountNumber}-compact2.png` +
    `?amount=${amount}&addInfo=${encodeURIComponent(content)}&accountName=${encodeURIComponent(accountName)}`
  );
}
