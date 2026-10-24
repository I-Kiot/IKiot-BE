// Dữ liệu thử màn Đóng hàng (dev only).
//
// Chạy SAU chuỗi seed của tài liệu test (docs/tai-khoan-test-hanh-trinh.md):
//
//   npx prisma db seed
//   npx tsx prisma/seed-account-role.ts
//   npx tsx prisma/seed-furniture-test.ts
//   npx tsx prisma/seed-c6-pack.ts
//
// Tạo trong shop "Nội thất Demo" (chủ shop 0981189856):
//   - kho riêng "Kho test đóng gói (C-6)" với tồn riêng (nhập bằng openLot, nên stock = Σ lô và có dòng
//     sổ kho). Kho riêng để các đơn ở đây không ăn vào tồn CN Hà Nội mà kịch bản K1–K11 dựa vào;
//   - 2 kiện khai báo cho sofa SOFA-MILAN-L (để thấy 1 đơn vị sinh 2 thùng) - áp cho SKU ở mọi nơi;
//   - 6 đơn CONFIRMED mã C6-TEST-01…06, mỗi đơn là một kịch bản (xem SCENARIOS), mỗi đơn kèm hoá đơn
//     PENDING như đơn thật (InvoiceService.ensurePending).
// Idempotent: kho tìm theo tên, tồn chỉ nhập khi SKU chưa có dòng tồn ở kho đó, đơn trùng mã thì bỏ qua.
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '../generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { InventoryService } from '../src/modules/inventories/inventories.service';
import { InvoiceService } from '../src/modules/invoices/invoices.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { NotificationService } from '../src/modules/notifications/notifications.service';
import {
  InventoryRefType,
  InventoryTxType,
  LotSourceType,
} from '../src/common/constants/inventory-ledger';
import { OrderStatus } from '../src/common/constants/order-status';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });
// openLot và ensurePending chỉ dùng transaction client được truyền vào - không cần Nest, không gửi thông báo.
const inventory = new InventoryService(
  prisma as unknown as PrismaService,
  {} as NotificationService,
);
const invoices = new InvoiceService(prisma as unknown as PrismaService);

const OWNER_PHONE = '0981189856';
const BRANCH_NAME = 'CN Hà Nội';
const WAREHOUSE_NAME = 'Kho test đóng gói (C-6)';
const CUSTOMER_NAME = 'Khách test đóng gói (C-6)';
const TWO_PACKAGE_SKU = 'SOFA-MILAN-L';

/** Tồn ban đầu ở kho C-6. SKU không có ở đây = chưa từng có ở kho (trên kệ 0). */
const STOCK: Record<string, number> = {
  'BAN-OAK-120': 10,
  'GHE-ERGO-DEN': 3,
  'SOFA-MILAN-L': 4,
};

type Line = { sku: string; quantity: number; from?: 'WAREHOUSE' | 'BRANCH' };

/** Mỗi đơn một kịch bản; thứ tự đóng gợi ý ghi trong `note`. */
const SCENARIOS: { code: string; note: string; lines: Line[] }[] = [
  {
    code: 'C6-TEST-01',
    note: 'Đủ hàng, 1 dòng → đóng được, 2 thùng',
    lines: [{ sku: 'BAN-OAK-120', quantity: 2 }],
  },
  {
    code: 'C6-TEST-02',
    note: 'Đủ hàng, nhiều dòng; sofa có 2 kiện → 1 bàn + 1 ghế + 1 sofa×2 kiện = 4 thùng',
    lines: [
      { sku: 'BAN-OAK-120', quantity: 1 },
      { sku: 'GHE-ERGO-DEN', quantity: 1 },
      { sku: 'SOFA-MILAN-L', quantity: 1 },
    ],
  },
  {
    code: 'C6-TEST-03',
    note: 'Thiếu 2 dòng → INSUFFICIENT_STOCK liệt kê cả ghế lẫn kệ',
    lines: [
      { sku: 'GHE-ERGO-DEN', quantity: 5 },
      { sku: 'KE-5T', quantity: 1 },
      { sku: 'BAN-OAK-120', quantity: 1 },
    ],
  },
  {
    code: 'C6-TEST-04',
    note: 'Tranh hàng với 05: ghế còn 2 sau đơn 02 → đóng 04 trước thì 05 thiếu',
    lines: [{ sku: 'GHE-ERGO-DEN', quantity: 2 }],
  },
  {
    code: 'C6-TEST-05',
    note: 'Tranh hàng với 04',
    lines: [{ sku: 'GHE-ERGO-DEN', quantity: 2 }],
  },
  {
    code: 'C6-TEST-06',
    note: 'Xuất từ 2 nơi → FULFILLMENT_ORDER_NOT_READY',
    lines: [
      { sku: 'BAN-OAK-120', quantity: 1 },
      { sku: 'SOFA-MILAN-L', quantity: 1, from: 'BRANCH' },
    ],
  },
];

async function main() {
  const owner = await prisma.user.findFirst({
    where: { phoneNumber: OWNER_PHONE, systemRole: 'TENANT_OWNER' },
  });
  if (!owner?.tenantId) {
    throw new Error(`Chưa có chủ shop ${OWNER_PHONE} - chạy seed-account-role.ts trước.`);
  }
  const tenantId = owner.tenantId;

  const branch = await prisma.location.findFirst({ where: { tenantId, name: BRANCH_NAME } });
  if (!branch) throw new Error(`Chưa có "${BRANCH_NAME}" - chạy seed-account-role.ts trước.`);
  const warehouse = await ensureWarehouse(tenantId);

  const skus = [...new Set(SCENARIOS.flatMap((s) => s.lines.map((l) => l.sku)))];
  const items = await prisma.productItem.findMany({
    where: { tenantId, sku: { in: skus } },
    select: { id: true, sku: true, productName: true, retailPrice: true },
  });
  const bySku = new Map(items.map((i) => [i.sku, i]));
  const missing = skus.filter((s) => !bySku.has(s));
  if (missing.length) throw new Error(`Không tìm thấy SKU: ${missing.join(', ')}`);

  // 1. Tồn kho ở kho tổng - chỉ khi SKU chưa có dòng tồn ở đó.
  for (const [sku, quantity] of Object.entries(STOCK)) {
    const item = bySku.get(sku)!;
    const existing = await prisma.inventory.findFirst({
      where: { tenantId, locationId: warehouse.id, productItemId: item.id },
    });
    if (existing) {
      console.log(`Tồn ${sku}: đã có (stock ${existing.stock}, khoá ${existing.lockedStock}) - giữ nguyên.`);
      continue;
    }
    await prisma.$transaction((tx) =>
      inventory.openLot(tx, {
        tenantId,
        locationId: warehouse.id,
        productItemId: item.id,
        quantity,
        sourceType: LotSourceType.OPENING,
        ledger: {
          type: InventoryTxType.OPENING,
          referenceType: InventoryRefType.INVENTORY,
          referenceId: 'seed-c6-pack',
          createdById: owner.id,
          note: 'Tồn đầu kỳ để test C-6',
        },
      }),
    );
    console.log(`Tồn ${sku}: nhập ${quantity} vào ${warehouse.name}.`);
  }

  // 2. Sofa giao thành 2 kiện.
  const sofa = bySku.get(TWO_PACKAGE_SKU)!;
  if ((await prisma.productPackage.count({ where: { productItemId: sofa.id } })) === 0) {
    await prisma.productPackage.createMany({
      data: [
        { productItemId: sofa.id, position: 1 },
        { productItemId: sofa.id, position: 2 },
      ],
    });
    console.log(`${TWO_PACKAGE_SKU}: khai báo 2 kiện.`);
  }

  // 3. Khách và các đơn CONFIRMED.
  const customer =
    (await prisma.customer.findFirst({ where: { tenantId, name: CUSTOMER_NAME } })) ??
    (await prisma.customer.create({ data: { tenantId, name: CUSTOMER_NAME } }));

  for (const scenario of SCENARIOS) {
    if (await prisma.order.findFirst({ where: { tenantId, code: scenario.code } })) {
      console.log(`${scenario.code}: đã có - bỏ qua.`);
      continue;
    }
    const lines = scenario.lines.map((line) => {
      const item = bySku.get(line.sku)!;
      const price = Number(item.retailPrice);
      return {
        productItemId: item.id,
        productName: item.productName,
        sku: item.sku,
        quantity: line.quantity,
        listUnitPrice: price,
        unitPrice: price,
        lineTotal: price * line.quantity,
        sourceLocationId: line.from === 'BRANCH' ? branch.id : warehouse.id,
      };
    });
    const grandTotal = lines.reduce((sum, l) => sum + l.lineTotal, 0);
    await prisma.$transaction(async (tx) => {
      const order = await tx.order.create({
        data: {
          tenantId,
          code: scenario.code,
          branchId: branch.id, // Branch.id = Location.id
          customerId: customer.id,
          userId: owner.id,
          assigneeId: owner.id,
          status: OrderStatus.CONFIRMED,
          confirmedById: owner.id,
          confirmedAt: new Date(),
          subtotal: grandTotal,
          grandTotal,
          note: scenario.note,
          items: { create: lines },
        },
        select: { id: true },
      });
      // Mọi đơn có đúng một hoá đơn SALE từ lúc tạo (CLAUDE.md, "Invoices").
      await invoices.ensurePending(tx, order.id);
    });
    console.log(`${scenario.code}: tạo - ${scenario.note}`);
  }
}

/** Kho riêng của C-6, tạo như LocationService tạo (Warehouse.id = Location.id). */
async function ensureWarehouse(tenantId: string) {
  const existing = await prisma.location.findFirst({
    where: { tenantId, name: WAREHOUSE_NAME },
  });
  if (existing) return existing;
  const id = randomUUID();
  const created = await prisma.location.create({
    data: {
      id,
      tenantId,
      name: WAREHOUSE_NAME,
      type: 'WAREHOUSE',
      // Đơn chỉ được xuất từ nơi bán được (manual-order.service) - kho này là nguồn của các đơn C-6.
      isSellable: true,
      warehouse: { create: { id, tenantId } },
    },
  });
  console.log(`Kho: tạo "${WAREHOUSE_NAME}".`);
  return created;
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
