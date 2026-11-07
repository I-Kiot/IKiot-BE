// Shop mẫu riêng với sản phẩm lấy từ igm.vn (07/11/2026): 2 sản phẩm thường, mỗi cái 2 phiên bản, và 1 combo. Chỉ dữ liệu dev, mật khẩu là DEMO_PASSWORD.
// Tên, thuộc tính, kích thước, bảo hành và giá bán lấy từ trang sản phẩm. Trang không có giá vốn và combo, nên giá vốn và combo (tên, giá) là số tự đặt. Chưa có ảnh, chưa có tồn kho.
// Chạy sau `npx prisma db seed` (cần bảng Plan), từ máy dev vì image deploy không có tsx và src/: `DATABASE_URL=<db đích> npx tsx prisma/seed-igm-sample.ts`.
// Chạy lại an toàn: thứ đã có thì giữ nguyên.
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import * as bcrypt from 'bcryptjs';
import { PrismaClient } from '../generated/prisma/client';
import {
  itemTypeFor,
  ProductStatus,
  ProductType,
} from '../src/common/constants/product-status';
import { writeComboComponents } from '../src/modules/products/combo-components';
import { writeItemDetails } from '../src/modules/products/product-attributes';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const DEMO_PASSWORD = 'password123';

const SHOP = {
  name: 'Nội thất Mộc An',
  phoneNumber: '0976214358',
  mainAddress: '86 Nguyễn Khang, Cầu Giấy, Hà Nội',
};
const OWNER = {
  phoneNumber: SHOP.phoneNumber,
  email: 'chushop@noithatmocan.example',
  lastName: 'Trịnh Minh',
  firstName: 'Khôi',
};
const BRANCH_NAME = 'CN Cầu Giấy';
const DAMAGED_NAME = 'Kho hàng hỏng';

const BRAND = 'IGM';
const CATEGORY_DESK = 'Bàn IKEA';
const CATEGORY_CHAIR = 'Ghế';

type Variant = {
  sku: string;
  name: string;
  details: [string, string][];
  retailPrice: number;
  costPrice: number;
  lengthCm?: number;
  widthCm?: number;
  heightCm?: number;
  weightKg?: number;
};

type SampleProduct = {
  name: string;
  category: string;
  warranty: string;
  description: string;
  manufacturable: boolean;
  variants: Variant[];
};

const DESK_NAME = 'Bàn IGM 2 Hộc tủ Đen (Mặt bàn MDF - Màu Óc chó)';
const CHAIR_NAME = 'Ghế Xoay Văn Phòng Công Thái Học Ergonomics GVP-130';

// https://igm.vn/products/ban-gaming-igm-hai-hoc-tu-den-mat-ban-oc-cho (mã HHT011-1, 24 tổ hợp, chọn 2)
// https://igm.vn/products/ghe-xoay-van-phong-cong-thai-hoc-ergonomics-gvp-130 (mã GCTH010-1)
const PRODUCTS: SampleProduct[] = [
  {
    name: DESK_NAME,
    category: CATEGORY_DESK,
    warranty: '12 tháng',
    description:
      'Mặt bàn gỗ MDF màu óc chó, hộc tủ màu đen, phủ Melamine chống ẩm và trầy xước. Cao 75cm, mặt bàn dày 3,5cm. Hộc tủ dài 60cm, rộng 40cm, cao 71,5cm.',
    manufacturable: true,
    variants: [
      {
        sku: 'HHT011-140-NAU-60',
        name: 'Bàn IGM 2 Hộc tủ Đen - 1m4, lõi nâu, rộng 60',
        details: [
          ['Kích thước', '1m4'],
          ['Vật liệu', 'Gỗ MDF thường (lõi nâu)'],
          ['Kiểu dáng', 'Mặt bàn rộng 60'],
        ],
        retailPrice: 2_500_000,
        costPrice: 1_500_000,
        lengthCm: 140,
        widthCm: 60,
        heightCm: 75,
      },
      {
        sku: 'HHT011-160-XANH-70',
        name: 'Bàn IGM 2 Hộc tủ Đen - 1m6, lõi xanh, rộng 70',
        details: [
          ['Kích thước', '1m6'],
          ['Vật liệu', 'Gỗ MDF lõi xanh'],
          ['Kiểu dáng', 'Mặt bàn rộng 70'],
        ],
        retailPrice: 3_800_000,
        costPrice: 2_300_000,
        lengthCm: 160,
        widthCm: 70,
        heightCm: 75,
      },
    ],
  },
  {
    name: CHAIR_NAME,
    category: CATEGORY_CHAIR,
    warranty: '6 tháng',
    description:
      'Khung nhựa ABS kết hợp vải lưới thoáng khí. Kích thước 122x62x52cm, nặng 11kg. Khách tự lắp, trong hộp có sẵn ốc vít và phụ kiện.',
    manufacturable: false,
    variants: [
      {
        sku: 'GVP130-TRANG',
        name: 'Ghế công thái học GVP-130 - Màu Trắng',
        details: [['Màu sắc', 'Trắng']],
        retailPrice: 1_350_000,
        costPrice: 800_000,
        lengthCm: 52,
        widthCm: 62,
        heightCm: 122,
        weightKg: 11,
      },
      {
        sku: 'GVP130-DEN',
        name: 'Ghế công thái học GVP-130 - Màu Đen',
        details: [['Màu sắc', 'Đen']],
        retailPrice: 1_350_000,
        costPrice: 800_000,
        lengthCm: 52,
        widthCm: 62,
        heightCm: 122,
        weightKg: 11,
      },
    ],
  },
];

// Giá vốn của combo do writeComboComponents tính từ thành phần (1.600.000).
const COMBO = {
  name: 'Combo 2 Ghế công thái học GVP-130 (1 Trắng + 1 Đen)',
  sku: 'COMBO-GVP130-2',
  category: CATEGORY_CHAIR,
  warranty: '6 tháng',
  description: 'Bộ 2 ghế GVP-130: 1 màu trắng và 1 màu đen.',
  retailPrice: 2_500_000,
  components: [
    { sku: 'GVP130-TRANG', quantity: 1 },
    { sku: 'GVP130-DEN', quantity: 1 },
  ],
};

async function findOrCreate<T extends { id: string }>(
  find: () => Promise<T | null>,
  create: () => Promise<T>,
): Promise<T> {
  return (await find()) ?? (await create());
}

async function seedShop() {
  const existing = await prisma.user.findFirst({
    where: { phoneNumber: OWNER.phoneNumber },
    select: { id: true, tenantId: true, systemRole: true },
  });
  if (existing) {
    if (!existing.tenantId || existing.systemRole !== 'TENANT_OWNER') {
      throw new Error(
        `Phone ${OWNER.phoneNumber} belongs to another account - change OWNER.`,
      );
    }
    console.log(`Owner ${OWNER.phoneNumber} already exists, reusing the shop.`);
    return { tenantId: existing.tenantId, ownerId: existing.id };
  }
  const password = await bcrypt.hash(DEMO_PASSWORD, 10);
  return prisma.$transaction(async (tx) => {
    const tenant = await tx.tenant.create({ data: SHOP });
    const owner = await tx.user.create({
      data: {
        tenantId: tenant.id,
        phoneNumber: OWNER.phoneNumber,
        email: OWNER.email,
        password,
        systemRole: 'TENANT_OWNER',
        status: 'ACTIVE',
        profileFirstName: OWNER.firstName,
        profileLastName: OWNER.lastName,
      },
    });
    await tx.tenant.update({
      where: { id: tenant.id },
      data: { tenantOwnerId: owner.id },
    });
    console.log(`Created shop "${SHOP.name}" with owner ${OWNER.phoneNumber}.`);
    return { tenantId: tenant.id, ownerId: owner.id };
  });
}

/** PRO (không giới hạn quota) một năm, như seed-account-role.ts. */
async function seedSubscription(tenantId: string, ownerId: string) {
  if (await prisma.subscription.findFirst({ where: { tenantId } })) return;
  const plan = await prisma.plan.findFirst({ where: { planCode: 'PRO' } });
  if (!plan) {
    throw new Error('Plan PRO not found - run `npx prisma db seed` first.');
  }
  const startDate = new Date();
  const endDate = new Date(startDate);
  endDate.setFullYear(endDate.getFullYear() + 1);
  await prisma.subscription.create({
    data: {
      tenantId,
      planId: plan.id,
      status: 'ACTIVE',
      startDate,
      endDate,
      autoRenew: false,
      quotaSnapshotMaxBranches: plan.maxBranches,
      quotaSnapshotMaxWarehouses: plan.maxWarehouses,
      quotaSnapshotMaxUsers: plan.maxUsers,
      quotaSnapshotMaxProducts: plan.maxProducts,
      historyLogs: {
        create: {
          event: 'CREATED',
          toPlanId: plan.id,
          changedAt: startDate,
          changedById: ownerId,
          note: 'IGM sample seed',
        },
      },
    },
  });
  console.log('Assigned PRO subscription for one year.');
}

async function seedLocations(tenantId: string) {
  const damaged = await findOrCreate(
    () =>
      prisma.location.findFirst({
        where: { tenantId, name: DAMAGED_NAME },
        select: { id: true },
      }),
    () => {
      // Mọi địa điểm đều có dòng `branches` vì kho cũng tạo được đơn; kho có thêm dòng `warehouses`, như LocationService.
      const id = randomUUID();
      const specialization = { create: { id, tenantId } };
      return prisma.location.create({
        data: {
          id,
          tenantId,
          name: DAMAGED_NAME,
          type: 'WAREHOUSE',
          isSellable: false,
          branch: specialization,
          warehouse: specialization,
        },
        select: { id: true },
      });
    },
  );
  await findOrCreate(
    () =>
      prisma.location.findFirst({
        where: { tenantId, name: BRANCH_NAME },
        select: { id: true },
      }),
    () => {
      const id = randomUUID();
      return prisma.location.create({
        data: {
          id,
          tenantId,
          name: BRANCH_NAME,
          type: 'BRANCH',
          address: SHOP.mainAddress,
          phoneNumber: [SHOP.phoneNumber],
          damagedLocationId: damaged.id,
          branch: { create: { id, tenantId } },
        },
        select: { id: true },
      });
    },
  );
}

async function seedCatalogue(tenantId: string) {
  const brand = await findOrCreate(
    () => prisma.brand.findFirst({ where: { tenantId, name: BRAND } }),
    () => prisma.brand.create({ data: { tenantId, name: BRAND } }),
  );
  const categoryIds = new Map<string, string>();
  for (const name of [CATEGORY_DESK, CATEGORY_CHAIR]) {
    const row = await findOrCreate(
      () => prisma.category.findFirst({ where: { tenantId, name } }),
      () => prisma.category.create({ data: { tenantId, name } }),
    );
    categoryIds.set(name, row.id);
  }

  // Mã hàng theo ProductService.allocateItemCodes (SP000001...).
  let counter = await prisma.productItem.count({ where: { tenantId } });
  const nextCode = () => `SP${String(++counter).padStart(6, '0')}`;
  const productData = (
    name: string,
    category: string,
    productType: ProductType,
    isManufacturable: boolean,
  ) => ({
    tenantId,
    name,
    status: ProductStatus.ACTIVE,
    brandId: brand.id,
    categoryId: categoryIds.get(category),
    categoryName: category,
    productType,
    isManufacturable,
  });

  for (const product of PRODUCTS) {
    const existing = await prisma.product.findFirst({
      where: { tenantId, name: product.name },
      select: { id: true },
    });
    if (existing) continue;
    await prisma.$transaction(async (tx) => {
      const row = await tx.product.create({
        data: productData(
          product.name,
          product.category,
          ProductType.PRODUCT,
          product.manufacturable,
        ),
      });
      for (const { details, name, ...variant } of product.variants) {
        const item = await tx.productItem.create({
          data: {
            ...variant,
            tenantId,
            productId: row.id,
            productName: name,
            productCode: nextCode(),
            description: product.description,
            warrantyPeriod: product.warranty,
            itemType: itemTypeFor(ProductType.PRODUCT),
          },
          select: { id: true },
        });
        await writeItemDetails(
          tx,
          tenantId,
          row.id,
          item.id,
          details.map(([attribute, value]) => ({ name: attribute, value })),
        );
      }
    });
    console.log(`Created product "${product.name}".`);
  }

  const comboExists = await prisma.product.findFirst({
    where: { tenantId, name: COMBO.name },
    select: { id: true },
  });
  if (comboExists) return;
  const parts = await prisma.productItem.findMany({
    where: { tenantId, sku: { in: COMBO.components.map((c) => c.sku) } },
    select: { id: true, sku: true },
  });
  const partId = new Map(parts.map((part) => [part.sku, part.id]));
  await prisma.$transaction(async (tx) => {
    const row = await tx.product.create({
      data: productData(COMBO.name, COMBO.category, ProductType.COMBO, false),
    });
    const item = await tx.productItem.create({
      data: {
        tenantId,
        productId: row.id,
        productName: COMBO.name,
        productCode: nextCode(),
        sku: COMBO.sku,
        description: COMBO.description,
        retailPrice: COMBO.retailPrice,
        costPrice: 0,
        warrantyPeriod: COMBO.warranty,
        itemType: itemTypeFor(ProductType.COMBO),
      },
      select: { id: true },
    });
    await writeComboComponents(
      tx,
      tenantId,
      item.id,
      COMBO.components.map((component) => {
        const componentItemId = partId.get(component.sku);
        if (!componentItemId) throw new Error(`SKU ${component.sku} not found`);
        return { componentItemId, quantity: component.quantity };
      }),
    );
  });
  console.log(`Created combo "${COMBO.name}".`);
}

async function main() {
  const { tenantId, ownerId } = await seedShop();
  await seedSubscription(tenantId, ownerId);
  await seedLocations(tenantId);
  await seedCatalogue(tenantId);
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
