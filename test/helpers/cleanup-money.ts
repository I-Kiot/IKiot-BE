import type { PrismaService } from '../../src/prisma/prisma.service';

/**
 * Xoá dấu vết tiền của một tenant TRƯỚC khi xoá tenant: các bảng sổ có khoá ngoại tenant kiểu RESTRICT nên chặn `tenant.delete`.
 * Mọi suite đụng tới tiền gọi hàm này đầu phần dọn; các Phase sau thêm bảng mới (nhật ký doanh thu, sổ SePay nền tảng, công nợ nhà cung cấp) vào đây, để không suite nào phải nhớ từng bảng.
 * Thứ tự: dòng con trước dòng cha.
 */
export async function deleteTenantMoneyTrail(
  prisma: PrismaService,
  tenantId: string,
): Promise<void> {
  // Nhật ký doanh thu (FK tenant RESTRICT, chỉ-ghi-thêm nhưng DELETE vẫn được; dòng con cascade theo bút toán).
  await prisma.salesJournalEntry.deleteMany({ where: { tenantId } });
  // Sổ công nợ NCC, lịch sử nhận tiền và lịch sử giá (FK tenant RESTRICT, chỉ-ghi-thêm nhưng DELETE vẫn được). Sổ công nợ xoá trước dòng thu chi mà nó trỏ tới.
  await prisma.supplierDebtEntry.deleteMany({ where: { tenantId } });
  await prisma.tenantBankingChange.deleteMany({ where: { tenantId } });
  await prisma.productItemPriceChange.deleteMany({ where: { tenantId } });
  await prisma.platformSepayTransaction.deleteMany({ where: { tenantId } });
  await prisma.sepayTransaction.deleteMany({ where: { tenantId } });
  await prisma.cashFlow.deleteMany({ where: { tenantId } });
}
