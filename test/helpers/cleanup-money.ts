import type { PrismaService } from '../../src/prisma/prisma.service';

/** Xoá dấu vết tiền của tenant trước khi xoá tenant, dòng con trước. */
export async function deleteTenantMoneyTrail(
  prisma: PrismaService,
  tenantId: string,
): Promise<void> {
  // Xoá nhật ký doanh thu.
  await prisma.salesJournalEntry.deleteMany({ where: { tenantId } });
  // Xoá sổ công nợ NCC, lịch sử nhận tiền và lịch sử giá.
  await prisma.supplierDebtEntry.deleteMany({ where: { tenantId } });
  await prisma.tenantBankingChange.deleteMany({ where: { tenantId } });
  await prisma.productItemPriceChange.deleteMany({ where: { tenantId } });
  await prisma.platformSepayTransaction.deleteMany({ where: { tenantId } });
  await prisma.sepayTransaction.deleteMany({ where: { tenantId } });
  await prisma.cashFlow.deleteMany({ where: { tenantId } });
}
