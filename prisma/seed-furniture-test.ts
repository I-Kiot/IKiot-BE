// Catalogue, suppliers, customers and opening stock for the manual test of the order journey -
// a transcription of docs/tai-khoan-test-hanh-trinh.md part 1.5, into the shop that
// seed-account-role.ts creates (owner "Nguyễn Thị Demo", 0981189856). If that file changes,
// change this one with it.
//
// Run `npx prisma db seed` and `npx tsx prisma/seed-account-role.ts` first, then:
//
//   npx tsx prisma/seed-furniture-test.ts
//
// Stock enters the way the app puts it there (CLAUDE.md, "Opening stock is not a field"): a
// RECEIVED IMPORT movement per location, one lot per line, an IMPORT ledger row, the
// supplier's debt raised - so Σ lot.remaining = stock and the supplier ledger adds up to
// the 50.100.000 the test file states. `receiveGoods` is a seed-only copy of that write
// (InventoryService.openLot + SupplierService.charge sit behind Nest DI a tsx script cannot
// boot); keep the two in step if the receipt changes.
//
// Idempotent per part: categories / brand / suppliers / customers / products are found by
// name, and the opening stock is skipped once the supplier has any movement.
import 'dotenv/config';
import { PrismaClient } from '../generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const OWNER_PHONE = '0981189856';
const BRAND = 'IMG Furniture';
const CATEGORIES = ['Bàn', 'Ghế', 'Tủ', 'Sofa', 'Kệ'];

const SUPPLIERS = [
  {
    supplierName: 'NCC Gỗ Việt',
    type: 'GOODS',
    phoneNumber: '0243000001',
  },
  {
    supplierName: 'Xưởng Mộc An Phát',
    type: 'WORKSHOP',
    phoneNumber: '0243000002',
  },
] as const;

const CUSTOMERS = [
  {
    name: 'Trần Văn An',
    phone: '0912000001',
    address: '12 Láng Hạ, Đống Đa, Hà Nội',
  },
  {
    name: 'Lê Thị Bình',
    phone: '0912000002',
    address: '45 Cầu Giấy, Hà Nội',
  },
  {
    name: 'Công ty TNHH Minh Long',
    phone: '0912000003',
    address: '8 Duy Tân, Cầu Giấy, Hà Nội',
  },
];

type Product = {
  name: string;
  category: string;
  warranty: string;
  variants: {
    sku: string;
    name: string;
    details: [string, string][];
    retailPrice: number;
    costPrice: number;
  }[];
};

// VAT is left empty on every variant so an order's total is price × quantity (test file 1.5).
const PRODUCTS: Product[] = [
  {
    name: 'Bàn làm việc Oak',
    category: 'Bàn',
    warranty: '12 tháng',
    variants: [
      {
        sku: 'BAN-OAK-120',
        name: 'Bàn làm việc Oak 120×60',
        details: [
          ['Kích thước', '120×60×75 cm'],
          ['Chất liệu', 'Gỗ sồi'],
          ['Màu', 'Óc chó'],
        ],
        retailPrice: 3_000_000,
        costPrice: 2_000_000,
      },
      {
        sku: 'BAN-OAK-140',
        name: 'Bàn làm việc Oak 140×70',
        details: [
          ['Kích thước', '140×70×75 cm'],
          ['Chất liệu', 'Gỗ sồi'],
          ['Màu', 'Óc chó'],
        ],
        retailPrice: 3_600_000,
        costPrice: 2_400_000,
      },
    ],
  },
  {
    name: 'Ghế xoay Ergo',
    category: 'Ghế',
    warranty: '12 tháng',
    variants: [
      {
        sku: 'GHE-ERGO-DEN',
        name: 'Ghế xoay Ergo – Đen',
        details: [
          ['Màu', 'Đen'],
          ['Chất liệu', 'Lưới'],
          ['Chân', 'Nhôm'],
        ],
        retailPrice: 1_000_000,
        costPrice: 600_000,
      },
      {
        sku: 'GHE-ERGO-XAM',
        name: 'Ghế xoay Ergo – Xám',
        details: [
          ['Màu', 'Xám'],
          ['Chất liệu', 'Lưới'],
          ['Chân', 'Nhôm'],
        ],
        retailPrice: 1_000_000,
        costPrice: 600_000,
      },
    ],
  },
  {
    name: 'Tủ hồ sơ 3 cánh',
    category: 'Tủ',
    warranty: '12 tháng',
    variants: [
      {
        sku: 'TU-HS-3C',
        name: 'Tủ hồ sơ 3 cánh',
        details: [
          ['Kích thước', '120×45×180 cm'],
          ['Chất liệu', 'MDF chống ẩm'],
          ['Màu', 'Trắng'],
        ],
        retailPrice: 2_500_000,
        costPrice: 1_500_000,
      },
    ],
  },
  {
    name: 'Sofa góc Milan',
    category: 'Sofa',
    warranty: '24 tháng',
    variants: [
      {
        sku: 'SOFA-MILAN-L',
        name: 'Sofa góc Milan chữ L',
        details: [
          ['Kích thước', '260×160×85 cm'],
          ['Chất liệu', 'Vải nỉ'],
          ['Màu', 'Xám ghi'],
        ],
        retailPrice: 15_000_000,
        costPrice: 9_000_000,
      },
    ],
  },
  {
    name: 'Kệ sách 5 tầng',
    category: 'Kệ',
    warranty: '12 tháng',
    variants: [
      {
        sku: 'KE-5T',
        name: 'Kệ sách 5 tầng',
        details: [
          ['Kích thước', '80×30×180 cm'],
          ['Chất liệu', 'Gỗ thông'],
        ],
        retailPrice: 1_200_000,
        costPrice: 700_000,
      },
    ],
  },
];

/** Test file 1.5.5. TU-HS-3C and KE-5T at Hà Nội are deliberately absent (stock 0 there). */
const OPENING_STOCK: Record<'HANOI' | 'HCM', Record<string, number>> = {
  HANOI: {
    'BAN-OAK-120': 10,
    'BAN-OAK-140': 3,
    'GHE-ERGO-DEN': 2,
    'GHE-ERGO-XAM': 1,
    'SOFA-MILAN-L': 1,
  },
  HCM: { 'BAN-OAK-120': 5, 'KE-5T': 3 },
};
/** Low-stock threshold at Hà Nội: packing one chair in K1 leaves 1 on the shelf → warning. */
const MIN_STOCK_HANOI: Record<string, number> = {
  'BAN-OAK-120': 2,
  'GHE-ERGO-DEN': 1,
};

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

async function findOrCreate<T extends { id: string }>(
  find: () => Promise<T | null>,
  create: () => Promise<T>,
): Promise<T> {
  return (await find()) ?? (await create());
}

async function receiveGoods(
  tx: Tx,
  args: {
    tenantId: string;
    actorId: string;
    supplierId: string;
    locationId: string;
    lines: { productItemId: string; quantity: number; unitCost: number }[];
  },
) {
  const receivedAt = new Date();
  const total = args.lines.reduce((sum, l) => sum + l.quantity * l.unitCost, 0);
  const movement = await tx.stockMovementRequest.create({
    data: {
      tenantId: args.tenantId,
      movementType: 'IMPORT',
      importSource: 'SUPPLIER',
      status: 'RECEIVED',
      fromSupplierId: args.supplierId,
      toLocationId: args.locationId,
      createdById: args.actorId,
      receivedById: args.actorId,
      receivedAt,
      totalPrice: total,
      note: 'Tồn đầu (seed test)',
      details: {
        create: args.lines.map((l) => ({
          productItemId: l.productItemId,
          quantity: l.quantity,
          importPrice: l.unitCost,
          receivedQuantity: l.quantity,
        })),
      },
    },
    select: {
      id: true,
      details: { select: { id: true, productItemId: true } },
    },
  });

  for (const line of args.lines) {
    const inventory = await tx.inventory.upsert({
      where: {
        tenantId_locationId_productItemId: {
          tenantId: args.tenantId,
          locationId: args.locationId,
          productItemId: line.productItemId,
        },
      },
      create: {
        tenantId: args.tenantId,
        locationId: args.locationId,
        productItemId: line.productItemId,
        stock: line.quantity,
      },
      update: { stock: { increment: line.quantity } },
    });
    const lot = await tx.inventoryLot.create({
      data: {
        tenantId: args.tenantId,
        locationId: args.locationId,
        productItemId: line.productItemId,
        sourceType: 'SUPPLIER',
        supplierId: args.supplierId,
        importItemId: movement.details.find(
          (d) => d.productItemId === line.productItemId,
        )?.id,
        unitCost: line.unitCost,
        receivedQuantity: line.quantity,
        remainingQuantity: line.quantity,
        receivedAt,
      },
    });
    await tx.inventoryTransaction.create({
      data: {
        tenantId: args.tenantId,
        locationId: args.locationId,
        productItemId: line.productItemId,
        type: 'IMPORT',
        quantity: line.quantity,
        balanceAfter: inventory.stock,
        unitCost: line.unitCost,
        referenceType: 'STOCK_MOVEMENT',
        referenceId: movement.id,
        createdById: args.actorId,
        lotId: lot.id,
        createdAt: receivedAt,
      },
    });
  }

  await tx.productItemSupplier.createMany({
    data: args.lines.map((l) => ({
      productItemId: l.productItemId,
      supplierId: args.supplierId,
    })),
    skipDuplicates: true,
  });
  await tx.supplier.update({
    where: { id: args.supplierId },
    data: { outstandingDebt: { increment: total } },
  });
}

async function main() {
  const owner = await prisma.user.findFirst({
    where: { phoneNumber: OWNER_PHONE, systemRole: 'TENANT_OWNER' },
    select: { id: true, tenantId: true },
  });
  if (!owner?.tenantId) {
    throw new Error(
      `Owner ${OWNER_PHONE} not found - run \`npx tsx prisma/seed-account-role.ts\` first.`,
    );
  }
  const tenantId = owner.tenantId;
  const ownerId = owner.id;

  const locations = await prisma.location.findMany({
    where: { tenantId, name: { in: ['CN Hà Nội', 'CN Hồ Chí Minh'] } },
    select: { id: true, name: true },
  });
  const locationId = {
    HANOI: locations.find((l) => l.name === 'CN Hà Nội')?.id,
    HCM: locations.find((l) => l.name === 'CN Hồ Chí Minh')?.id,
  };
  if (!locationId.HANOI || !locationId.HCM) {
    throw new Error(
      'CN Hà Nội / CN Hồ Chí Minh missing - run seed-account-role.ts.',
    );
  }

  // Categories, brand
  const categoryIds = new Map<string, string>();
  for (const name of CATEGORIES) {
    const row = await findOrCreate(
      () => prisma.category.findFirst({ where: { tenantId, name } }),
      () => prisma.category.create({ data: { tenantId, name } }),
    );
    categoryIds.set(name, row.id);
  }
  const brand = await findOrCreate(
    () => prisma.brand.findFirst({ where: { tenantId, name: BRAND } }),
    () => prisma.brand.create({ data: { tenantId, name: BRAND } }),
  );

  // Suppliers
  const supplierIds = new Map<string, string>();
  for (const s of SUPPLIERS) {
    const row = await findOrCreate(
      () =>
        prisma.supplier.findFirst({
          where: { tenantId, supplierName: s.supplierName },
        }),
      // creditLimit 0 = no limit.
      () =>
        prisma.supplier.create({ data: { tenantId, ...s, creditLimit: 0 } }),
    );
    supplierIds.set(s.supplierName, row.id);
  }

  // Customers, codes KH000001.. in the order of the test file.
  let customerCount = await prisma.customer.count({ where: { tenantId } });
  for (const c of CUSTOMERS) {
    const exists = await prisma.customer.findFirst({
      where: { tenantId, phone: c.phone },
      select: { id: true },
    });
    if (exists) continue;
    customerCount++;
    await prisma.customer.create({
      data: {
        tenantId,
        customerCode: `KH${String(customerCount).padStart(6, '0')}`,
        ...c,
      },
    });
  }

  // Products + variants. productCode follows ProductService.allocateItemCodes (SP000001...).
  let counter = await prisma.productItem.count({ where: { tenantId } });
  let createdProducts = 0;
  for (const product of PRODUCTS) {
    const existing = await prisma.product.findFirst({
      where: { tenantId, name: product.name },
      select: { id: true },
    });
    if (existing) continue;
    await prisma.$transaction(async (tx) => {
      const row = await tx.product.create({
        data: {
          tenantId,
          name: product.name,
          status: 'ACTIVE',
          brandId: brand.id,
          categoryId: categoryIds.get(product.category),
          categoryName: product.category,
        },
      });
      for (const v of product.variants) {
        await tx.productItem.create({
          data: {
            tenantId,
            productId: row.id,
            productName: v.name,
            productCode: `SP${String(++counter).padStart(6, '0')}`,
            sku: v.sku,
            retailPrice: v.retailPrice,
            costPrice: v.costPrice,
            warrantyPeriod: product.warranty,
            details: {
              create: v.details.map(([name, value], position) => ({
                name,
                value,
                position,
              })),
            },
          },
        });
      }
    });
    createdProducts++;
  }
  console.log(`Products: ${createdProducts} created.`);

  // Opening stock, one import per location from NCC Gỗ Việt.
  const goodsSupplierId = supplierIds.get('NCC Gỗ Việt')!;
  const alreadyReceived = await prisma.stockMovementRequest.count({
    where: { tenantId, fromSupplierId: goodsSupplierId },
  });
  if (alreadyReceived > 0) {
    console.log('Opening stock already received, skipped.');
  } else {
    const items = await prisma.productItem.findMany({
      where: { tenantId },
      select: { id: true, sku: true, costPrice: true },
    });
    const bySku = new Map(items.map((i) => [i.sku, i]));
    for (const key of ['HANOI', 'HCM'] as const) {
      const lines = Object.entries(OPENING_STOCK[key]).map(
        ([sku, quantity]) => {
          const item = bySku.get(sku);
          if (!item) throw new Error(`SKU ${sku} not found`);
          return {
            productItemId: item.id,
            quantity,
            unitCost: Number(item.costPrice),
          };
        },
      );
      await prisma.$transaction((tx) =>
        receiveGoods(tx, {
          tenantId,
          actorId: ownerId,
          supplierId: goodsSupplierId,
          locationId: locationId[key]!,
          lines,
        }),
      );
    }
    for (const [sku, minStock] of Object.entries(MIN_STOCK_HANOI)) {
      await prisma.inventory.updateMany({
        where: {
          tenantId,
          locationId: locationId.HANOI,
          productItemId: bySku.get(sku)!.id,
        },
        data: { minStock },
      });
    }
    const debt = await prisma.supplier.findUniqueOrThrow({
      where: { id: goodsSupplierId },
      select: { outstandingDebt: true },
    });
    console.log(
      `Opening stock received. NCC Gỗ Việt debt: ${Number(debt.outstandingDebt).toLocaleString('vi-VN')} (expected 50.100.000).`,
    );
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
