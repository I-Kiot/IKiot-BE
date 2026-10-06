// Dữ liệu thử màn Đóng hàng (dev only, không commit nếu không cần).
//
// Chạy SAU `npx prisma db seed` và `npx tsx prisma/seed-furniture.ts`:
//
//   npx tsx prisma/seed-c6-pack.ts
//
// Tạo trong shop "Nội thất IGM Demo":
//   - tồn kho ở "Kho tổng Long Biên" (nhập bằng openLot, nên stock = Σ lô và có dòng sổ kho),
//   - 2 kiện khai báo cho tủ TU-NKA-DEN (để thấy 1 đơn vị sinh 2 thùng),
//   - 6 đơn CONFIRMED mã C6-TEST-01…06, mỗi đơn là một kịch bản (xem SCENARIOS).
// Idempotent: tồn kho chỉ nhập khi SKU chưa có dòng tồn ở kho; đơn trùng mã thì bỏ qua.
import 'dotenv/config';
import { PrismaClient } from '../generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { InventoryService } from '../src/modules/inventories/inventories.service';
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
// openLot chỉ dùng transaction client được truyền vào - không cần Nest, không gửi thông báo.
const inventory = new InventoryService(
  prisma as unknown as PrismaService,
  {} as NotificationService,
);

const SHOP_NAME = 'Nội thất IGM Demo';
const CUSTOMER_NAME = 'Khách test đóng gói (C-6)';

/** Tồn ban đầu ở kho tổng. SKU không có ở đây = chưa từng có ở kho (trên kệ 0). */
const STOCK: Record<string, number> = {
  'BAN-IKEA-TRANG-140': 10,
  'GHE-GVP110-DEN': 3,
  'TU-NKA-DEN': 4,
};

type Line = { sku: string; quantity: number; from?: 'WAREHOUSE' | 'SHOWROOM' };

/** Mỗi đơn một kịch bản; thứ tự đóng gợi ý ghi trong `note`. */
const SCENARIOS: { code: string; note: string; lines: Line[] }[] = [
  {
    code: 'C6-TEST-01',
    note: 'Đủ hàng, 1 dòng → đóng được, 2 thùng',
    lines: [{ sku: 'BAN-IKEA-TRANG-140', quantity: 2 }],
  },
  {
    code: 'C6-TEST-02',
    note: 'Đủ hàng, nhiều dòng; tủ có 2 kiện → 1 bàn + 1 ghế + 1 tủ×2 kiện = 4 thùng',
    lines: [
      { sku: 'BAN-IKEA-TRANG-140', quantity: 1 },
      { sku: 'GHE-GVP110-DEN', quantity: 1 },
      { sku: 'TU-NKA-DEN', quantity: 1 },
    ],
  },
  {
    code: 'C6-TEST-03',
    note: 'Thiếu 2 dòng → INSUFFICIENT_STOCK liệt kê cả ghế lẫn kệ',
    lines: [
      { sku: 'GHE-GVP110-DEN', quantity: 5 },
      { sku: 'KE-3T-NK-TRANG', quantity: 1 },
      { sku: 'BAN-IKEA-TRANG-140', quantity: 1 },
    ],
  },
  {
    code: 'C6-TEST-04',
    note: 'Tranh hàng với 05: ghế còn 2 sau đơn 02 → đóng 04 trước thì 05 thiếu',
    lines: [{ sku: 'GHE-GVP110-DEN', quantity: 2 }],
  },
  {
    code: 'C6-TEST-05',
    note: 'Tranh hàng với 04',
    lines: [{ sku: 'GHE-GVP110-DEN', quantity: 2 }],
  },
  {
    code: 'C6-TEST-06',
    note: 'Xuất từ 2 nơi → FULFILLMENT_ORDER_NOT_READY',
    lines: [
      { sku: 'BAN-IKEA-TRANG-140', quantity: 1 },
      { sku: 'TU-NKA-DEN', quantity: 1, from: 'SHOWROOM' },
    ],
  },
];

async function main() {
  const tenant = await prisma.tenant.findFirst({ where: { name: SHOP_NAME } });
  if (!tenant) throw new Error(`Chưa có shop "${SHOP_NAME}" - chạy seed-furniture.ts trước.`);
  const tenantId = tenant.id;

  const [owner, showroom, warehouse] = await Promise.all([
    prisma.user.findFirstOrThrow({ where: { tenantId, systemRole: 'TENANT_OWNER' } }),
    prisma.location.findFirstOrThrow({ where: { tenantId, name: 'Showroom Cầu Giấy' } }),
    prisma.location.findFirstOrThrow({ where: { tenantId, name: 'Kho tổng Long Biên' } }),
  ]);

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

  // 2. Tủ TU-NKA-DEN giao thành 2 kiện.
  const wardrobe = bySku.get('TU-NKA-DEN')!;
  if ((await prisma.productPackage.count({ where: { productItemId: wardrobe.id } })) === 0) {
    await prisma.productPackage.createMany({
      data: [
        { productItemId: wardrobe.id, position: 1 },
        { productItemId: wardrobe.id, position: 2 },
      ],
    });
    console.log('TU-NKA-DEN: khai báo 2 kiện.');
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
        sourceLocationId: line.from === 'SHOWROOM' ? showroom.id : warehouse.id,
      };
    });
    const grandTotal = lines.reduce((sum, l) => sum + l.lineTotal, 0);
    await prisma.order.create({
      data: {
        tenantId,
        code: scenario.code,
        branchId: showroom.id, // Branch.id = Location.id
        customerId: customer.id,
        userId: owner.id,
        assigneeId: owner.id,
        status: OrderStatus.CONFIRMED,
        confirmedById: owner.id,
        confirmedAt: new Date(),
        grandTotal,
        note: scenario.note,
        items: { create: lines },
      },
    });
    console.log(`${scenario.code}: tạo - ${scenario.note}`);
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
