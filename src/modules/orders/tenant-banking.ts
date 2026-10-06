import { BadRequestException } from '@nestjs/common';
import { ErrorCode } from '../../common/errors/error-codes';
import type { PrismaService } from '../../prisma/prisma.service';

// Tài khoản ngân hàng của shop cho thanh toán SePay / VietQR: một chỗ duy nhất cho cả bán tại quầy
// (OrderService) lẫn thu tiền khi giao (ShipmentDeliveryService). Là hàm thuần, không phải service, vì
// module orders đã import module shipments – đặt trong một service của orders thì shipments không gọi
// ngược lại được.

/** Ba cột ngân hàng cần để dựng mã QR. */
export interface TenantBanking {
  bankingBankName: string | null;
  bankingAccountNumber: string | null;
  bankingAccountName: string | null;
}

/** Shop phải đã cài tài khoản nhận tiền, nếu không thì không có chỗ cho tiền chuyển khoản về. */
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
    },
  });
  if (!tenant?.bankingAccountNumber || !tenant.bankingBankName) {
    throw new BadRequestException({
      code: ErrorCode.TENANT_BANKING_NOT_CONFIGURED,
      message:
        'This shop has not configured its bank details for SePay payments',
    });
  }
  return tenant;
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
  return (
    `https://img.vietqr.io/image/${bankName}-${accountNumber}-compact2.png` +
    `?amount=${amount}&addInfo=${encodeURIComponent(paymentReference)}&accountName=${encodeURIComponent(accountName)}`
  );
}
