// Shop thời trang (quần áo, giày dép, phụ kiện) để test thủ công - thay cho seed-furniture-test.ts. Dev only.
//
// Chạy sau:
//   npx prisma db seed
//   npx tsx prisma/seed-account-role.ts
//   npx tsx prisma/seed-fashion.ts
//
// Hai nguồn hàng, đúng hai luồng nhập của app:
//   - Hàng hãng Adidas / Nike: mua từ nhà phân phối (Supplier GOODS) - tồn đầu là phiếu nhập SUPPLIER.
//   - Hàng tự may "IKI Studio": đặt Xưởng may Phúc Thịnh (Supplier WORKSHOP, isManufacturable) - tồn đầu là
//     YCSX đã nhận đủ (COMPLETED) + phiếu nhập WORKSHOP, như `ProductionRequestService.receiveGoods`.
//     Thêm một YCSX đã gửi (SENT) chưa nhận, để thử bước nhận hàng xưởng.
// Mọi lần nhập đi qua `InventoryService.openLot` nên stock = Σ lot.remaining và có dòng sổ kho.
//
// Shop tạo bởi seed-account-role.ts được đổi tên thành SHOP_NAME. Seed nội thất không chạy cùng seed này
// (seed-c5/c6 dựa vào SKU nội thất).
// Idempotent theo từng phần: danh mục/thương hiệu/NCC/khách/sản phẩm tìm theo tên; tồn đầu bỏ qua khi đã có YCSX.
import 'dotenv/config';
import { PrismaClient } from '../generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { writeItemDetails } from '../src/modules/products/product-attributes';
import { ProductType } from '../src/common/constants/product-status';
import { InventoryService } from '../src/modules/inventories/inventories.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { NotificationService } from '../src/modules/notifications/notifications.service';
import {
  ImportSource,
  InventoryRefType,
  InventoryTxType,
  LotSourceType,
} from '../src/common/constants/inventory-ledger';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });
// openLot chỉ dùng transaction client được truyền vào - không cần Nest, không gửi thông báo.
const inventory = new InventoryService(
  prisma as unknown as PrismaService,
  {} as NotificationService,
);

const OWNER_PHONE = '0981189856';
const SHOP_NAME = 'Thời trang Demo';
const OWN_BRAND = 'IKI Studio';

type LocKey = 'HANOI' | 'HCM';
const LOCATION_NAMES: Record<LocKey, string> = {
  HANOI: 'CN Hà Nội',
  HCM: 'CN Hồ Chí Minh',
};

const CATEGORIES = [
  'Áo thun',
  'Áo sơ mi',
  'Áo khoác',
  'Quần',
  'Váy đầm',
  'Giày',
  'Dép',
  'Phụ kiện',
];

const BRANDS = [
  { name: 'Adidas', description: 'Hàng chính hãng, nhập từ nhà phân phối' },
  { name: 'Nike', description: 'Hàng chính hãng, nhập từ nhà phân phối' },
  { name: OWN_BRAND, description: 'Thương hiệu riêng của shop, đặt xưởng may' },
];

const SUP = {
  ADIDAS: 'Công ty TNHH Phân phối Adidas Việt Nam',
  NIKE: 'Công ty CP Thương mại Nike Việt Nam',
  WORKSHOP: 'Xưởng may Phúc Thịnh',
} as const;

const SUPPLIERS = [
  {
    supplierName: SUP.ADIDAS,
    type: 'GOODS',
    contactName: 'Phan Thị Hồng',
    phoneNumber: '0283000101',
    email: 'order@adidas-npp.vn',
    address: '123 Nguyễn Văn Linh, Quận 7, TP. Hồ Chí Minh',
  },
  {
    supplierName: SUP.NIKE,
    type: 'GOODS',
    contactName: 'Lý Văn Thắng',
    phoneNumber: '0243000102',
    email: 'sales@nike-tm.vn',
    address: '72 Lê Thánh Tôn, Quận 1, TP. Hồ Chí Minh',
  },
  {
    supplierName: SUP.WORKSHOP,
    type: 'WORKSHOP',
    contactName: 'Ngô Văn Phúc',
    phoneNumber: '0243000103',
    address: 'Cụm CN La Phù, Hoài Đức, Hà Nội',
  },
] as const;

const CUSTOMERS = [
  {
    name: 'Nguyễn Thu Hà',
    phone: '0912100001',
    gender: 'FEMALE',
    address: '25 Hàng Bài, Hoàn Kiếm, Hà Nội',
  },
  {
    name: 'Trần Đức Mạnh',
    phone: '0912100002',
    gender: 'MALE',
    address: '108 Xuân Thủy, Cầu Giấy, Hà Nội',
  },
  {
    name: 'Phạm Ngọc Linh',
    phone: '0912100003',
    gender: 'FEMALE',
    address: '14 Nguyễn Huệ, Quận 1, TP. Hồ Chí Minh',
  },
  {
    name: 'Lê Hoàng Nam',
    phone: '0912100004',
    gender: 'MALE',
    address: '56 Võ Văn Tần, Quận 3, TP. Hồ Chí Minh',
  },
  {
    name: 'CLB Chạy bộ Hồ Tây',
    phone: '0912100005',
    gender: 'OTHER',
    address: '1 Thanh Niên, Tây Hồ, Hà Nội',
  },
];

type Variant = {
  sku: string;
  name: string;
  details: [string, string][];
  retailPrice: number;
  costPrice: number;
};

type ProductDef = {
  name: string;
  category: string;
  brand: string;
  /** Nhà phân phối cho hàng hãng; hàng IKI Studio để trống (đặt xưởng). */
  supplier?: (typeof SUP)[keyof typeof SUP];
  warranty?: string;
  variants: Variant[];
};

/** Mỗi tổ hợp (màu × size) là một SKU. `code` là phần đầu SKU, màu và size được nối vào. */
function matrix(args: {
  code: string;
  name: string;
  colors: [label: string, code: string][];
  sizes: string[];
  sizeLabel?: string;
  extra?: [string, string][];
  retailPrice: number;
  costPrice: number;
}): Variant[] {
  return args.colors.flatMap(([color, colorCode]) =>
    args.sizes.map((size) => ({
      sku: `${args.code}-${colorCode}-${size}`,
      name: `${args.name} – ${color} / ${size}`,
      details: [
        ['Màu', color],
        [args.sizeLabel ?? 'Size', size],
        ...(args.extra ?? []),
      ],
      retailPrice: args.retailPrice,
      costPrice: args.costPrice,
    })),
  );
}

const SHOE_SIZES = ['39', '40', '41', '42'];
const CLOTHES_SIZES = ['S', 'M', 'L', 'XL'];

const PRODUCTS: ProductDef[] = [
  // ---------- Adidas (nhà phân phối) ----------
  {
    name: 'Giày chạy bộ Adidas Ultraboost Light',
    category: 'Giày',
    brand: 'Adidas',
    supplier: SUP.ADIDAS,
    warranty: '6 tháng',
    variants: matrix({
      code: 'ADI-UBL',
      name: 'Adidas Ultraboost Light',
      colors: [
        ['Đen', 'DEN'],
        ['Trắng', 'TRG'],
      ],
      sizes: SHOE_SIZES,
      extra: [['Chất liệu', 'Primeknit+']],
      retailPrice: 4_500_000,
      costPrice: 3_100_000,
    }),
  },
  {
    name: 'Giày Adidas Samba OG',
    category: 'Giày',
    brand: 'Adidas',
    supplier: SUP.ADIDAS,
    warranty: '6 tháng',
    variants: matrix({
      code: 'ADI-SAMBA',
      name: 'Adidas Samba OG',
      colors: [['Trắng sọc đen', 'TRG']],
      sizes: SHOE_SIZES,
      extra: [['Chất liệu', 'Da bò']],
      retailPrice: 2_800_000,
      costPrice: 1_900_000,
    }),
  },
  {
    name: 'Dép Adidas Adilette Aqua',
    category: 'Dép',
    brand: 'Adidas',
    supplier: SUP.ADIDAS,
    variants: matrix({
      code: 'ADI-ADL',
      name: 'Adidas Adilette Aqua',
      colors: [
        ['Đen', 'DEN'],
        ['Xanh navy', 'NVY'],
      ],
      sizes: ['40', '41', '42'],
      retailPrice: 900_000,
      costPrice: 550_000,
    }),
  },
  {
    name: 'Áo thun Adidas Essentials 3-Stripes',
    category: 'Áo thun',
    brand: 'Adidas',
    supplier: SUP.ADIDAS,
    variants: matrix({
      code: 'ADI-ESS3S',
      name: 'Áo thun Adidas Essentials 3-Stripes',
      colors: [['Đen', 'DEN']],
      sizes: ['M', 'L', 'XL'],
      extra: [['Chất liệu', 'Cotton']],
      retailPrice: 750_000,
      costPrice: 450_000,
    }),
  },
  // ---------- Nike (nhà phân phối) ----------
  {
    name: "Giày Nike Air Force 1 '07",
    category: 'Giày',
    brand: 'Nike',
    supplier: SUP.NIKE,
    warranty: '6 tháng',
    variants: matrix({
      code: 'NIK-AF1',
      name: "Nike Air Force 1 '07",
      colors: [['Trắng', 'TRG']],
      sizes: SHOE_SIZES,
      extra: [['Chất liệu', 'Da tổng hợp']],
      retailPrice: 2_900_000,
      costPrice: 2_000_000,
    }),
  },
  {
    name: 'Giày chạy bộ Nike Pegasus 41',
    category: 'Giày',
    brand: 'Nike',
    supplier: SUP.NIKE,
    warranty: '6 tháng',
    variants: matrix({
      code: 'NIK-PEG41',
      name: 'Nike Pegasus 41',
      colors: [
        ['Đen', 'DEN'],
        ['Xanh dương', 'XDG'],
      ],
      sizes: ['40', '41', '42'],
      extra: [['Chất liệu', 'Lưới kỹ thuật']],
      retailPrice: 3_800_000,
      costPrice: 2_600_000,
    }),
  },
  {
    name: 'Dép Nike Victori One',
    category: 'Dép',
    brand: 'Nike',
    supplier: SUP.NIKE,
    variants: matrix({
      code: 'NIK-VIC',
      name: 'Nike Victori One',
      colors: [['Đen', 'DEN']],
      sizes: ['40', '41', '42'],
      retailPrice: 850_000,
      costPrice: 520_000,
    }),
  },
  {
    name: 'Áo khoác Nike Windrunner',
    category: 'Áo khoác',
    brand: 'Nike',
    supplier: SUP.NIKE,
    variants: matrix({
      code: 'NIK-WR',
      name: 'Áo khoác Nike Windrunner',
      colors: [
        ['Đen', 'DEN'],
        ['Xanh rêu', 'REU'],
      ],
      sizes: ['M', 'L'],
      extra: [['Chất liệu', 'Polyester chống gió']],
      retailPrice: 2_400_000,
      costPrice: 1_600_000,
    }),
  },
  {
    name: 'Quần short Nike Dri-FIT Challenger',
    category: 'Quần',
    brand: 'Nike',
    supplier: SUP.NIKE,
    variants: matrix({
      code: 'NIK-DFC',
      name: 'Quần short Nike Dri-FIT Challenger',
      colors: [['Đen', 'DEN']],
      sizes: ['M', 'L', 'XL'],
      retailPrice: 1_100_000,
      costPrice: 700_000,
    }),
  },
  // ---------- IKI Studio (đặt xưởng) ----------
  {
    name: 'Áo thun cotton basic IKI',
    category: 'Áo thun',
    brand: OWN_BRAND,
    variants: matrix({
      code: 'IKI-TEE',
      name: 'Áo thun cotton basic IKI',
      colors: [
        ['Trắng', 'TRG'],
        ['Đen', 'DEN'],
        ['Be', 'BE'],
      ],
      sizes: CLOTHES_SIZES,
      extra: [['Chất liệu', 'Cotton 100% 250gsm']],
      retailPrice: 250_000,
      costPrice: 95_000,
    }),
  },
  {
    name: 'Áo sơ mi linen IKI',
    category: 'Áo sơ mi',
    brand: OWN_BRAND,
    variants: matrix({
      code: 'IKI-SMLN',
      name: 'Áo sơ mi linen IKI',
      colors: [
        ['Trắng', 'TRG'],
        ['Xanh nhạt', 'XNH'],
      ],
      sizes: ['M', 'L', 'XL'],
      extra: [['Chất liệu', 'Linen']],
      retailPrice: 450_000,
      costPrice: 180_000,
    }),
  },
  {
    name: 'Quần jean slim fit IKI',
    category: 'Quần',
    brand: OWN_BRAND,
    variants: matrix({
      code: 'IKI-JEAN',
      name: 'Quần jean slim fit IKI',
      colors: [['Xanh đậm', 'XDM']],
      sizes: ['29', '30', '31', '32'],
      extra: [['Chất liệu', 'Denim co giãn']],
      retailPrice: 550_000,
      costPrice: 230_000,
    }),
  },
  {
    name: 'Quần kaki ống suông IKI',
    category: 'Quần',
    brand: OWN_BRAND,
    variants: matrix({
      code: 'IKI-KAKI',
      name: 'Quần kaki ống suông IKI',
      colors: [
        ['Be', 'BE'],
        ['Đen', 'DEN'],
      ],
      sizes: ['29', '30', '31', '32'],
      extra: [['Chất liệu', 'Kaki cotton']],
      retailPrice: 420_000,
      costPrice: 170_000,
    }),
  },
  {
    name: 'Váy hoa nhí dáng xòe IKI',
    category: 'Váy đầm',
    brand: OWN_BRAND,
    variants: matrix({
      code: 'IKI-VAY',
      name: 'Váy hoa nhí dáng xòe IKI',
      colors: [
        ['Hoa vàng', 'VAN'],
        ['Hoa xanh', 'XAN'],
      ],
      sizes: ['S', 'M', 'L'],
      extra: [['Chất liệu', 'Voan lụa']],
      retailPrice: 520_000,
      costPrice: 210_000,
    }),
  },
  {
    name: 'Dép da quai ngang IKI',
    category: 'Dép',
    brand: OWN_BRAND,
    warranty: '3 tháng',
    variants: matrix({
      code: 'IKI-DEP',
      name: 'Dép da quai ngang IKI',
      colors: [
        ['Nâu', 'NAU'],
        ['Đen', 'DEN'],
      ],
      sizes: ['39', '40', '41', '42'],
      extra: [['Chất liệu', 'Da bò thật']],
      retailPrice: 380_000,
      costPrice: 150_000,
    }),
  },
  {
    name: 'Túi tote canvas IKI',
    category: 'Phụ kiện',
    brand: OWN_BRAND,
    variants: [
      {
        sku: 'IKI-TOTE-KEM',
        name: 'Túi tote canvas IKI – Kem',
        details: [
          ['Màu', 'Kem'],
          ['Kích thước', '38×42 cm'],
          ['Chất liệu', 'Canvas 12oz'],
        ],
        retailPrice: 220_000,
        costPrice: 80_000,
      },
      {
        sku: 'IKI-TOTE-DEN',
        name: 'Túi tote canvas IKI – Đen',
        details: [
          ['Màu', 'Đen'],
          ['Kích thước', '38×42 cm'],
          ['Chất liệu', 'Canvas 12oz'],
        ],
        retailPrice: 220_000,
        costPrice: 80_000,
      },
    ],
  },
];

/**
 * Tồn đầu theo tiền tố SKU (mọi SKU bắt đầu bằng khoá nhận số lượng đó), theo chi nhánh.
 * Cố ý để vài chỗ trống/ít để thấy được "hết hàng tại đây", "sắp hết", "cần sản xuất".
 */
const OPENING: Record<LocKey, Record<string, number>> = {
  HANOI: {
    'ADI-UBL': 3,
    'ADI-SAMBA': 4,
    'ADI-ADL': 6,
    'ADI-ESS3S': 8,
    'NIK-AF1': 5,
    'NIK-PEG41-DEN': 2,
    'NIK-VIC': 6,
    'NIK-WR': 3,
    'NIK-DFC': 6,
    'IKI-TEE': 20,
    'IKI-SMLN': 10,
    'IKI-JEAN': 8,
    'IKI-KAKI-BE': 6,
    'IKI-VAY': 5,
    'IKI-DEP': 4,
    'IKI-TOTE': 15,
  },
  HCM: {
    'ADI-UBL-DEN': 2,
    'ADI-SAMBA': 3,
    'ADI-ADL': 4,
    'NIK-AF1': 4,
    'NIK-PEG41': 2,
    'NIK-DFC': 4,
    'IKI-TEE-TRG': 12,
    'IKI-TEE-DEN': 12,
    'IKI-JEAN': 5,
    'IKI-VAY': 4,
    'IKI-TOTE-KEM': 10,
  },
};

/** Ngưỡng sắp hết hàng tại Hà Nội, theo tiền tố SKU. */
const MIN_STOCK_HANOI: Record<string, number> = {
  'ADI-UBL': 2,
  'NIK-PEG41': 2,
  'IKI-TEE': 5,
  'IKI-DEP': 3,
};

/** YCSX đã gửi xưởng, chưa nhận: đặt thêm kaki đen (Hà Nội đang 0) và váy. */
const OPEN_YCSX_LINES: Record<string, number> = {
  'IKI-KAKI-DEN-30': 10,
  'IKI-KAKI-DEN-31': 10,
  'IKI-VAY-VAN-M': 8,
};

function quantityFor(table: Record<string, number>, sku: string) {
  // Tiền tố dài nhất thắng, để 'NIK-PEG41-DEN' đè 'NIK-PEG41'.
  const key = Object.keys(table)
    .filter((prefix) => sku === prefix || sku.startsWith(`${prefix}-`))
    .sort((a, b) => b.length - a.length)[0];
  return key ? table[key] : 0;
}

type Item = {
  id: string;
  sku: string;
  costPrice: number;
  supplier?: string;
};

async function findOrCreate<T extends { id: string }>(
  find: () => Promise<T | null>,
  create: () => Promise<T>,
): Promise<T> {
  return (await find()) ?? (await create());
}

/** Phiếu nhập NCC đã nhận (RECEIVED): phiếu + lot + sổ kho + công nợ, như luồng nhận hàng của app. */
async function receiveFromSupplier(args: {
  tenantId: string;
  actorId: string;
  supplierId: string;
  locationId: string;
  lines: { item: Item; quantity: number }[];
}) {
  const receivedAt = new Date();
  const total = args.lines.reduce(
    (sum, l) => sum + l.quantity * l.item.costPrice,
    0,
  );
  await prisma.$transaction(async (tx) => {
    const movement = await tx.stockMovementRequest.create({
      data: {
        tenantId: args.tenantId,
        movementType: 'IMPORT',
        importSource: ImportSource.SUPPLIER,
        status: 'RECEIVED',
        fromSupplierId: args.supplierId,
        toLocationId: args.locationId,
        createdById: args.actorId,
        receivedById: args.actorId,
        receivedAt,
        totalPrice: total,
        note: 'Tồn đầu (seed thời trang)',
        details: {
          create: args.lines.map((l) => ({
            productItemId: l.item.id,
            quantity: l.quantity,
            importPrice: l.item.costPrice,
            receivedQuantity: l.quantity,
          })),
        },
      },
      select: {
        id: true,
        details: { select: { id: true, productItemId: true } },
      },
    });
    for (const l of args.lines) {
      await inventory.openLot(tx, {
        tenantId: args.tenantId,
        locationId: args.locationId,
        productItemId: l.item.id,
        quantity: l.quantity,
        unitCost: l.item.costPrice,
        sourceType: LotSourceType.SUPPLIER,
        supplierId: args.supplierId,
        importItemId: movement.details.find(
          (d) => d.productItemId === l.item.id,
        )?.id,
        receivedAt,
        ledger: {
          type: InventoryTxType.IMPORT,
          referenceType: InventoryRefType.STOCK_MOVEMENT,
          referenceId: movement.id,
          createdById: args.actorId,
        },
      });
    }
    await tx.productItemSupplier.createMany({
      data: args.lines.map((l) => ({
        productItemId: l.item.id,
        supplierId: args.supplierId,
      })),
      skipDuplicates: true,
    });
    await tx.supplier.update({
      where: { id: args.supplierId },
      data: { outstandingDebt: { increment: total } },
    });
  });
}

/**
 * YCSX đã nhận đủ: YCSX COMPLETED + phiếu nhập WORKSHOP + lot WORKSHOP + công nợ xưởng - cùng hình dạng
 * `ProductionRequestService.receiveGoods` để lại (không có hàng lỗi).
 */
async function receiveFromWorkshop(args: {
  tenantId: string;
  actorId: string;
  workshopId: string;
  locationId: string;
  code: string;
  lines: { item: Item; quantity: number }[];
}) {
  const now = new Date();
  const sentAt = new Date(now.getTime() - 14 * 24 * 3600 * 1000);
  const total = args.lines.reduce(
    (sum, l) => sum + l.quantity * l.item.costPrice,
    0,
  );
  await prisma.$transaction(async (tx) => {
    const request = await tx.productionRequest.create({
      data: {
        tenantId: args.tenantId,
        code: args.code,
        supplierId: args.workshopId,
        locationId: args.locationId,
        status: 'COMPLETED',
        sentAt,
        expectedReadyDate: now,
        note: 'Lô hàng đầu tiên (seed thời trang)',
        createdById: args.actorId,
        statusUpdatedById: args.actorId,
        statusUpdatedAt: now,
        createdAt: sentAt,
        items: {
          create: args.lines.map((l) => ({
            productItemId: l.item.id,
            quantity: l.quantity,
            receivedQuantity: l.quantity,
          })),
        },
      },
      select: { items: { select: { id: true, productItemId: true } } },
    });
    const requestLineOf = new Map(
      request.items.map((i) => [i.productItemId, i.id]),
    );
    const movement = await tx.stockMovementRequest.create({
      data: {
        tenantId: args.tenantId,
        movementType: 'IMPORT',
        importSource: ImportSource.WORKSHOP,
        status: 'RECEIVED',
        fromSupplierId: args.workshopId,
        toLocationId: args.locationId,
        createdById: args.actorId,
        receivedById: args.actorId,
        receivedAt: now,
        totalPrice: total,
        note: `Nhận hàng xưởng theo ${args.code}`,
        details: {
          create: args.lines.map((l) => ({
            productItemId: l.item.id,
            quantity: l.quantity,
            importPrice: l.item.costPrice,
            receivedQuantity: l.quantity,
            defectQuantity: 0,
            productionRequestItemId: requestLineOf.get(l.item.id),
          })),
        },
      },
      select: {
        id: true,
        details: { select: { id: true, productItemId: true } },
      },
    });
    for (const l of args.lines) {
      await inventory.openLot(tx, {
        tenantId: args.tenantId,
        locationId: args.locationId,
        productItemId: l.item.id,
        quantity: l.quantity,
        unitCost: l.item.costPrice,
        sourceType: LotSourceType.WORKSHOP,
        supplierId: args.workshopId,
        importItemId: movement.details.find(
          (d) => d.productItemId === l.item.id,
        )?.id,
        productionRequestItemId: requestLineOf.get(l.item.id),
        receivedAt: now,
        ledger: {
          type: InventoryTxType.IMPORT,
          referenceType: InventoryRefType.STOCK_MOVEMENT,
          referenceId: movement.id,
          createdById: args.actorId,
        },
      });
    }
    await tx.productItemSupplier.createMany({
      data: args.lines.map((l) => ({
        productItemId: l.item.id,
        supplierId: args.workshopId,
      })),
      skipDuplicates: true,
    });
    await tx.supplier.update({
      where: { id: args.workshopId },
      data: { outstandingDebt: { increment: total } },
    });
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

  await prisma.tenant.update({
    where: { id: tenantId },
    data: { name: SHOP_NAME },
  });

  const locations = await prisma.location.findMany({
    where: { tenantId, name: { in: Object.values(LOCATION_NAMES) } },
    select: { id: true, name: true },
  });
  const locationId = {} as Record<LocKey, string>;
  for (const key of Object.keys(LOCATION_NAMES) as LocKey[]) {
    const row = locations.find((l) => l.name === LOCATION_NAMES[key]);
    if (!row) {
      throw new Error(
        `${LOCATION_NAMES[key]} missing - run seed-account-role.ts.`,
      );
    }
    locationId[key] = row.id;
  }

  const categoryIds = new Map<string, string>();
  for (const name of CATEGORIES) {
    const row = await findOrCreate(
      () => prisma.category.findFirst({ where: { tenantId, name } }),
      () => prisma.category.create({ data: { tenantId, name } }),
    );
    categoryIds.set(name, row.id);
  }

  const brandIds = new Map<string, string>();
  for (const b of BRANDS) {
    const row = await findOrCreate(
      () => prisma.brand.findFirst({ where: { tenantId, name: b.name } }),
      () => prisma.brand.create({ data: { tenantId, ...b } }),
    );
    brandIds.set(b.name, row.id);
  }

  const supplierIds = new Map<string, string>();
  for (const s of SUPPLIERS) {
    const row = await findOrCreate(
      () =>
        prisma.supplier.findFirst({
          where: { tenantId, supplierName: s.supplierName },
        }),
      // creditLimit 0 = không giới hạn.
      () =>
        prisma.supplier.create({ data: { tenantId, ...s, creditLimit: 0 } }),
    );
    supplierIds.set(s.supplierName, row.id);
  }

  // Mã khách KH000001.. nối tiếp số khách đã có.
  let customerCount = await prisma.customer.count({ where: { tenantId } });
  for (const c of CUSTOMERS) {
    const exists = await prisma.customer.findFirst({
      where: { tenantId, phone: c.phone },
      select: { id: true },
    });
    if (exists) continue;
    await prisma.customer.create({
      data: {
        tenantId,
        customerCode: `KH${String(++customerCount).padStart(6, '0')}`,
        ...c,
      },
    });
  }

  // Sản phẩm + biến thể. productCode theo ProductService.allocateItemCodes (SP000001...).
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
          brandId: brandIds.get(product.brand),
          categoryId: categoryIds.get(product.category),
          categoryName: product.category,
          productType: ProductType.PRODUCT,
          // Hàng hãng chỉ nhập NCC; hàng IKI Studio đặt xưởng được (YCSX).
          isManufacturable: !product.supplier,
        },
      });
      for (const v of product.variants) {
        const item = await tx.productItem.create({
          data: {
            tenantId,
            productId: row.id,
            productName: v.name,
            productCode: `SP${String(++counter).padStart(6, '0')}`,
            sku: v.sku,
            retailPrice: v.retailPrice,
            costPrice: v.costPrice,
            warrantyPeriod: product.warranty,
          },
          select: { id: true },
        });
        await writeItemDetails(
          tx,
          tenantId,
          row.id,
          item.id,
          v.details.map(([name, value]) => ({ name, value })),
        );
      }
    });
    createdProducts++;
  }
  console.log(`Products: ${createdProducts} created.`);

  const workshopId = supplierIds.get(SUP.WORKSHOP)!;
  if (
    (await prisma.productionRequest.count({ where: { tenantId } })) > 0
  ) {
    console.log('Opening stock already received, skipped.');
    return;
  }

  const supplierOfSku = new Map<string, string | undefined>();
  for (const p of PRODUCTS) {
    for (const v of p.variants) supplierOfSku.set(v.sku, p.supplier);
  }
  const rows = await prisma.productItem.findMany({
    where: { tenantId, sku: { in: [...supplierOfSku.keys()] } },
    select: { id: true, sku: true, costPrice: true },
  });
  const items: Item[] = rows.map((r) => ({
    id: r.id,
    sku: r.sku!,
    costPrice: Number(r.costPrice),
    supplier: supplierOfSku.get(r.sku!),
  }));
  const bySku = new Map(items.map((i) => [i.sku, i]));

  let ycsx = 0;
  for (const key of ['HANOI', 'HCM'] as LocKey[]) {
    const lines = items
      .map((item) => ({ item, quantity: quantityFor(OPENING[key], item.sku) }))
      .filter((l) => l.quantity > 0);
    for (const name of [SUP.ADIDAS, SUP.NIKE]) {
      const own = lines.filter((l) => l.item.supplier === name);
      if (own.length === 0) continue;
      await receiveFromSupplier({
        tenantId,
        actorId: ownerId,
        supplierId: supplierIds.get(name)!,
        locationId: locationId[key],
        lines: own,
      });
    }
    const made = lines.filter((l) => !l.item.supplier);
    if (made.length > 0) {
      await receiveFromWorkshop({
        tenantId,
        actorId: ownerId,
        workshopId,
        locationId: locationId[key],
        code: `YCSX${String(++ycsx).padStart(6, '0')}`,
        lines: made,
      });
    }
  }

  for (const item of items) {
    const minStock = quantityFor(MIN_STOCK_HANOI, item.sku);
    if (!minStock) continue;
    await prisma.inventory.updateMany({
      where: { tenantId, locationId: locationId.HANOI, productItemId: item.id },
      data: { minStock },
    });
  }

  // Một YCSX đã gửi, chưa nhận - để thử bước nhận hàng xưởng.
  const sentAt = new Date();
  const ready = new Date(sentAt.getTime() + 10 * 24 * 3600 * 1000);
  await prisma.productionRequest.create({
    data: {
      tenantId,
      code: `YCSX${String(++ycsx).padStart(6, '0')}`,
      supplierId: workshopId,
      locationId: locationId.HANOI,
      status: 'SENT',
      sentAt,
      expectedReadyDate: ready,
      note: 'Bổ sung kaki đen và váy hoa vàng cho CN Hà Nội',
      createdById: ownerId,
      statusUpdatedById: ownerId,
      statusUpdatedAt: sentAt,
      items: {
        create: Object.entries(OPEN_YCSX_LINES).map(([sku, quantity]) => {
          const item = bySku.get(sku);
          if (!item) throw new Error(`SKU ${sku} not found`);
          return { productItemId: item.id, quantity };
        }),
      },
    },
  });

  const debts = await prisma.supplier.findMany({
    where: { tenantId },
    select: { supplierName: true, outstandingDebt: true },
  });
  console.log(
    `Opening stock received. Supplier debt: ${debts
      .map(
        (d) =>
          `${d.supplierName} ${Number(d.outstandingDebt).toLocaleString('vi-VN')}`,
      )
      .join('; ')}.`,
  );
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
