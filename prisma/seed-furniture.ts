// Demo furniture shop for trying the order journey (docs/hanh-trinh-don-hang.md): the shop,
// its owner, a PRO subscription, a showroom + a main warehouse + a damaged-goods warehouse,
// one Role per job in the journey with an account for each, and a catalogue modelled on
// igm.vn's range (office desks, ergonomic chairs, shelving, desk accessories - real list
// prices and dimensions). No stock, categories or combos: stock only arrives through a stock
// movement (CLAUDE.md, "Opening stock is not a field").
//
// Run `npx prisma db seed` first - the roles draw on the PermissionCatalog it writes. Then:
//
//   npx tsx prisma/seed-furniture.ts
//
// Idempotent: the shop is found by name, roles by name, accounts by phone number, products
// by name - anything already there is left untouched. Every account's password is
// DEMO_PASSWORD; the list is in ../docs/demo-furniture-accounts.md (workspace). Dev data only.
import 'dotenv/config';
import { PrismaClient } from '../generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import * as bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

// ── The shop ────────────────────────────────────────────────────────────────────

const DEMO_PASSWORD = '123123123';
const SHOP_NAME = 'Nội thất IGM Demo';
const OWNER = {
  phoneNumber: '0901000000',
  email: 'chushop@noithat-demo.vn',
  firstName: 'Minh',
  lastName: 'Nguyễn Văn',
};

type LocationKey = 'SHOWROOM' | 'MAIN_WAREHOUSE' | 'DAMAGED_WAREHOUSE';

const LOCATIONS: {
  key: LocationKey;
  name: string;
  type: 'BRANCH' | 'WAREHOUSE';
  isSellable: boolean;
  address: string;
}[] = [
  {
    key: 'SHOWROOM',
    name: 'Showroom Cầu Giấy',
    type: 'BRANCH',
    isSellable: true,
    address: '120 Trần Duy Hưng, Cầu Giấy, Hà Nội',
  },
  {
    key: 'MAIN_WAREHOUSE',
    name: 'Kho tổng Long Biên',
    type: 'WAREHOUSE',
    isSellable: true,
    address: 'KCN Sài Đồng B, Long Biên, Hà Nội',
  },
  {
    key: 'DAMAGED_WAREHOUSE',
    name: 'Kho hàng hỏng',
    type: 'WAREHOUSE',
    isSellable: false,
    address: 'KCN Sài Đồng B, Long Biên, Hà Nội',
  },
];

/**
 * One role per job in the order journey. The STAFF base set (profile, products:read...) is
 * granted by JwtStrategy to every staff account and stripped from what a role stores, so it
 * is not listed here.
 */
const ROLES: {
  name: string;
  description: string;
  permissions: [string, string[]][];
}[] = [
  {
    name: 'Quản lý cửa hàng',
    description:
      'Điều phối mọi đơn: tạo, gán người phụ trách, xác nhận Đang vận chuyển, xác nhận tiền shipper nộp, xử lý hoàn hàng.',
    permissions: [
      [
        'orders',
        [
          'create',
          'read',
          'update',
          'view_all',
          'assign',
          'confirm',
          'pack',
          'ship',
          'confirm_remittance',
        ],
      ],
      ['customers', ['create', 'read', 'update']],
      ['production_requests', ['read', 'receive']],
      ['shipments', ['create', 'read', 'update']],
      ['returns', ['create', 'read', 'inspect', 'cancel']],
      ['inventory', ['read', 'view_all']],
      ['stock_movement', ['read']],
      ['payments', ['read']],
      ['reports', ['read']],
    ],
  },
  {
    name: 'Nhân viên bán hàng',
    description:
      'Tạo đơn tay, chọn người phụ trách, nhập tiền cọc, sửa đơn khi còn ở Xác nhận, tạo yêu cầu hoàn cho đơn mình phụ trách.',
    permissions: [
      ['orders', ['create', 'read', 'update', 'assign']],
      ['customers', ['create', 'read', 'update']],
      ['production_requests', ['read']],
      ['inventory', ['read']],
      ['returns', ['create', 'read']],
    ],
  },
  {
    name: 'Thủ kho',
    description:
      'Kiểm hàng sản xuất về và nhập số đã sản xuất (tăng tồn kho), xác nhận Đang vận chuyển (trừ tồn kho), kiểm hàng hoàn.',
    permissions: [
      ['orders', ['read', 'view_all', 'pack', 'ship']],
      ['production_requests', ['read', 'receive']],
      ['inventory', ['read', 'update', 'view_all']],
      ['stock_movement', ['create', 'read', 'update', 'receive']],
      ['shipments', ['create', 'read']],
      ['returns', ['read', 'inspect']],
    ],
  },
  {
    name: 'Nhân viên đóng gói',
    description:
      'Đóng gói đơn (Đóng đơn) và ghi nhận shipper / ĐVVC đã đến lấy hàng.',
    permissions: [
      ['orders', ['read', 'view_all', 'pack']],
      ['shipments', ['create', 'read']],
      ['inventory', ['read']],
    ],
  },
  {
    name: 'Shipper / thợ lắp đặt',
    description:
      'Xem đơn cần giao kèm số tiền còn phải thu, chụp ảnh bằng chứng, xác nhận đã giao và hình thức khách trả.',
    permissions: [['shipments', ['deliver']]],
  },
  {
    name: 'Kế toán',
    description:
      'Xác nhận đã nhận đủ tiền mặt từ shipper, theo dõi thanh toán và dòng tiền.',
    permissions: [
      ['orders', ['read', 'view_all', 'confirm_remittance']],
      ['payments', ['read']],
      ['cash_flows', ['read']],
      ['reports', ['read']],
    ],
  },
];

const STAFF: {
  phoneNumber: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  location: LocationKey;
}[] = [
  {
    phoneNumber: '0901000001',
    email: 'quanly@noithat-demo.vn',
    firstName: 'Hùng',
    lastName: 'Trần Quốc',
    role: 'Quản lý cửa hàng',
    location: 'SHOWROOM',
  },
  {
    phoneNumber: '0901000002',
    email: 'banhang1@noithat-demo.vn',
    firstName: 'Lan',
    lastName: 'Phạm Thị',
    role: 'Nhân viên bán hàng',
    location: 'SHOWROOM',
  },
  {
    phoneNumber: '0901000003',
    email: 'banhang2@noithat-demo.vn',
    firstName: 'Tuấn',
    lastName: 'Lê Anh',
    role: 'Nhân viên bán hàng',
    location: 'SHOWROOM',
  },
  {
    phoneNumber: '0901000004',
    email: 'thukho@noithat-demo.vn',
    firstName: 'Dũng',
    lastName: 'Hoàng Văn',
    role: 'Thủ kho',
    location: 'MAIN_WAREHOUSE',
  },
  {
    phoneNumber: '0901000005',
    email: 'donggoi@noithat-demo.vn',
    firstName: 'Nam',
    lastName: 'Vũ Đức',
    role: 'Nhân viên đóng gói',
    location: 'MAIN_WAREHOUSE',
  },
  {
    phoneNumber: '0901000006',
    email: 'shipper1@noithat-demo.vn',
    firstName: 'Long',
    lastName: 'Đỗ Văn',
    role: 'Shipper / thợ lắp đặt',
    location: 'MAIN_WAREHOUSE',
  },
  {
    phoneNumber: '0901000007',
    email: 'shipper2@noithat-demo.vn',
    firstName: 'Khoa',
    lastName: 'Bùi Minh',
    role: 'Shipper / thợ lắp đặt',
    location: 'MAIN_WAREHOUSE',
  },
  {
    phoneNumber: '0901000008',
    email: 'ketoan@noithat-demo.vn',
    firstName: 'Hương',
    lastName: 'Ngô Thu',
    role: 'Kế toán',
    location: 'SHOWROOM',
  },
];

async function assertCatalogSeeded() {
  const pairs = ROLES.flatMap((role) =>
    role.permissions.flatMap(([resource, actions]) =>
      actions.map((action) => ({ resource, action })),
    ),
  );
  const found = await prisma.permissionCatalog.findMany({
    where: { OR: pairs },
    select: { resource: true, action: true },
  });
  const have = new Set(found.map((p) => `${p.resource}:${p.action}`));
  const missing = [
    ...new Set(pairs.map((p) => `${p.resource}:${p.action}`)),
  ].filter((key) => !have.has(key));
  if (missing.length) {
    throw new Error(
      `Permission catalog is missing ${missing.join(', ')} - run \`npx prisma db seed\` first.`,
    );
  }
}

async function seedShop(passwordHash: string) {
  const existing = await prisma.tenant.findFirst({
    where: { name: SHOP_NAME },
    select: { id: true, tenantOwnerId: true },
  });
  if (existing?.tenantOwnerId) {
    console.log(`Shop "${SHOP_NAME}" already exists, reusing it.`);
    return { tenantId: existing.id, ownerId: existing.tenantOwnerId };
  }
  const phoneTaken = await prisma.user.findFirst({
    where: { phoneNumber: OWNER.phoneNumber },
    select: { id: true },
  });
  if (phoneTaken) {
    throw new Error(
      `Phone ${OWNER.phoneNumber} already belongs to another account.`,
    );
  }

  return prisma.$transaction(async (tx) => {
    const tenant = await tx.tenant.create({
      data: {
        name: SHOP_NAME,
        phoneNumber: OWNER.phoneNumber,
        mainAddress: '120 Trần Duy Hưng, Cầu Giấy, Hà Nội',
      },
    });
    const owner = await tx.user.create({
      data: {
        tenantId: tenant.id,
        phoneNumber: OWNER.phoneNumber,
        email: OWNER.email,
        password: passwordHash,
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
    console.log(`Created shop "${SHOP_NAME}" with owner ${OWNER.phoneNumber}.`);
    return { tenantId: tenant.id, ownerId: owner.id };
  });
}

async function seedLocations(
  tenantId: string,
): Promise<Record<LocationKey, string>> {
  const ids = {} as Record<LocationKey, string>;
  for (const loc of LOCATIONS) {
    const existing = await prisma.location.findFirst({
      where: { tenantId, name: loc.name },
      select: { id: true },
    });
    if (existing) {
      ids[loc.key] = existing.id;
      continue;
    }
    // The branch / warehouse row takes the Location's own id, as LocationService does.
    const id = randomUUID();
    const specialization = { create: { id, tenantId } };
    await prisma.location.create({
      data: {
        id,
        tenantId,
        name: loc.name,
        type: loc.type,
        isSellable: loc.isSellable,
        address: loc.address,
        ...(loc.type === 'BRANCH'
          ? { branch: specialization }
          : { warehouse: specialization }),
      },
    });
    ids[loc.key] = id;
  }
  // Damaged goods from either sellable location go to the damaged-goods warehouse, and the
  // showroom ships from the main warehouse (the contract's defaultFulfillmentLocationId).
  await prisma.location.updateMany({
    where: { id: { in: [ids.SHOWROOM, ids.MAIN_WAREHOUSE] } },
    data: { damagedLocationId: ids.DAMAGED_WAREHOUSE },
  });
  await prisma.location.update({
    where: { id: ids.SHOWROOM },
    data: { defaultFulfillmentLocationId: ids.MAIN_WAREHOUSE },
  });
  return ids;
}

/** PRO (unlimited quotas) for a year - the trial plan's caps would get in the way of a demo. */
async function seedSubscription(tenantId: string, ownerId: string) {
  const existing = await prisma.subscription.findFirst({ where: { tenantId } });
  if (existing) return;
  const plan = await prisma.plan.findFirst({ where: { planCode: 'PRO' } });
  if (!plan)
    throw new Error('Plan PRO not found - run `npx prisma db seed` first.');
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
          note: 'Demo seed',
        },
      },
    },
  });
  console.log('Assigned PRO subscription for one year.');
}

async function seedRoles(tenantId: string): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const role of ROLES) {
    const existing = await prisma.role.findUnique({
      where: { tenantId_name: { tenantId, name: role.name } },
      select: { id: true },
    });
    if (existing) {
      ids.set(role.name, existing.id);
      continue;
    }
    const row = await prisma.role.create({
      data: {
        tenantId,
        name: role.name,
        description: role.description,
        permissions: {
          create: role.permissions.flatMap(([resource, actions]) =>
            actions.map((action) => ({ resource, action })),
          ),
        },
      },
    });
    ids.set(role.name, row.id);
  }
  console.log(`Roles ready: ${[...ids.keys()].join(', ')}.`);
  return ids;
}

async function seedStaff(
  tenantId: string,
  ownerId: string,
  passwordHash: string,
  roleIds: Map<string, string>,
  locations: Record<LocationKey, string>,
) {
  let created = 0;
  for (const person of STAFF) {
    const existing = await prisma.user.findFirst({
      where: { phoneNumber: person.phoneNumber },
      select: { tenantId: true },
    });
    if (existing) {
      if (existing.tenantId !== tenantId) {
        console.warn(
          `Phone ${person.phoneNumber} belongs to another shop, skipped.`,
        );
      }
      continue;
    }
    await prisma.user.create({
      data: {
        tenantId,
        phoneNumber: person.phoneNumber,
        email: person.email,
        password: passwordHash,
        systemRole: 'STAFF',
        status: 'ACTIVE',
        roleId: roleIds.get(person.role),
        locationId: locations[person.location],
        createdById: ownerId,
        hireDate: new Date(),
        profileFirstName: person.firstName,
        profileLastName: person.lastName,
      },
    });
    created++;
  }
  // The showroom and the warehouse each get their appointed manager.
  const byRole = (role: string) =>
    STAFF.find((person) => person.role === role)?.phoneNumber;
  for (const [key, role] of [
    ['SHOWROOM', 'Quản lý cửa hàng'],
    ['MAIN_WAREHOUSE', 'Thủ kho'],
  ] as const) {
    const manager = await prisma.user.findFirst({
      where: { tenantId, phoneNumber: byRole(role) },
      select: { id: true },
    });
    if (manager) {
      await prisma.location.update({
        where: { id: locations[key] },
        data: { managerId: manager.id },
      });
    }
  }
  console.log(
    `Staff accounts: ${created} created, ${STAFF.length - created} already present.`,
  );
}

// ── The catalogue ───────────────────────────────────────────────────────────────

/** Same prefix `ProductService.allocateItemCodes` counts from, so the app's next code follows on. */
const CODE_PREFIX = 'SP';

interface SeedVariant {
  sku: string;
  retailPrice: number;
  costPrice: number;
  /** Shown as the variant's attributes (Màu, Kích thước...). */
  details: Record<string, string>;
  lengthCm?: number;
  widthCm?: number;
  heightCm?: number;
  weightKg?: number;
  allowCustomization?: boolean;
  customLeadTimeDays?: number;
}

interface SeedProduct {
  name: string;
  description: string;
  warrantyPeriod: string;
  vat?: number;
  variants: SeedVariant[];
}

/** Desk frame colour × top finish - igm.vn sells each desk in these pairings. */
function deskVariants(
  base: string,
  sizes: { lengthCm: number; price: number; cost: number; weightKg: number }[],
  finishes: { code: string; frame: string; top: string }[],
  extra: Pick<SeedVariant, 'widthCm' | 'heightCm'>,
): SeedVariant[] {
  return sizes.flatMap((size) =>
    finishes.map((finish) => ({
      sku: `${base}-${finish.code}-${size.lengthCm}`,
      retailPrice: size.price,
      costPrice: size.cost,
      details: {
        'Kích thước': `${size.lengthCm / 100}m`,
        'Màu khung': finish.frame,
        'Mặt bàn': finish.top,
      },
      lengthCm: size.lengthCm,
      weightKg: size.weightKg,
      allowCustomization: true,
      customLeadTimeDays: 7,
      ...extra,
    })),
  );
}

const DESK_FINISHES = [
  { code: 'DEN-OC', frame: 'Đen', top: 'MDF vân óc chó' },
  { code: 'TRANG-SOI', frame: 'Trắng', top: 'MDF vân gỗ sồi' },
  { code: 'TRANG-TRANG', frame: 'Trắng', top: 'MDF trắng' },
];

const CHAIR_COLORS = [
  { code: 'DEN', name: 'Đen' },
  { code: 'XAM', name: 'Xám' },
];

const PRODUCTS: SeedProduct[] = [
  // ── Bàn làm việc ─────────────────────────────────────────────────────────────
  {
    name: 'Bàn IGM 2 hộc tủ',
    description:
      'Bàn làm việc 2 hộc tủ hai bên, mặt MDF lõi xanh chống ẩm phủ Melamine dày 3.5cm, chân sắt sơn tĩnh điện.',
    warrantyPeriod: '24 tháng',
    vat: 10,
    variants: deskVariants(
      'BAN-2HT',
      [
        { lengthCm: 160, price: 2_300_000, cost: 1_350_000, weightKg: 52 },
        { lengthCm: 180, price: 2_500_000, cost: 1_480_000, weightKg: 58 },
        { lengthCm: 200, price: 2_800_000, cost: 1_650_000, weightKg: 64 },
      ],
      DESK_FINISHES.slice(0, 2),
      { widthCm: 70, heightCm: 75 },
    ),
  },
  {
    name: 'Bàn IGM 1 hộc tủ',
    description:
      'Bàn làm việc 1 hộc tủ 3 ngăn, mặt MDF phủ Melamine dày 3.5cm. Kích thước 1m2 - 2m, đặt được kích thước riêng.',
    warrantyPeriod: '24 tháng',
    vat: 10,
    variants: deskVariants(
      'BAN-1HT',
      [
        { lengthCm: 120, price: 1_900_000, cost: 1_050_000, weightKg: 34 },
        { lengthCm: 140, price: 2_050_000, cost: 1_150_000, weightKg: 38 },
        { lengthCm: 160, price: 2_200_000, cost: 1_250_000, weightKg: 42 },
      ],
      DESK_FINISHES,
      { widthCm: 60, heightCm: 75 },
    ),
  },
  {
    name: 'Bàn IGM chữ L 1 hộc tủ 5 ngăn',
    description:
      'Bàn góc chữ L cạnh dài 2m4, hộc tủ 5 ngăn kéo, phù hợp góc làm việc nhiều màn hình.',
    warrantyPeriod: '24 tháng',
    vat: 10,
    variants: deskVariants(
      'BAN-L5N',
      [{ lengthCm: 240, price: 2_900_000, cost: 1_750_000, weightKg: 72 }],
      DESK_FINISHES,
      { widthCm: 60, heightCm: 75 },
    ),
  },
  {
    name: 'Bàn IKEA Lagkapten chân Alex',
    description:
      'Bàn phong cách IKEA: mặt Lagkapten trên 2 tủ Alex 5 ngăn, lắp ráp nhanh.',
    warrantyPeriod: '12 tháng',
    vat: 10,
    variants: [
      {
        sku: 'BAN-IKEA-TRANG-140',
        retailPrice: 3_200_000,
        costPrice: 2_100_000,
        details: { 'Kích thước': '1.4m', Màu: 'Trắng' },
        lengthCm: 140,
        widthCm: 60,
        heightCm: 73,
        weightKg: 45,
      },
      {
        sku: 'BAN-IKEA-DEN-140',
        retailPrice: 3_200_000,
        costPrice: 2_100_000,
        details: { 'Kích thước': '1.4m', Màu: 'Đen nâu' },
        lengthCm: 140,
        widthCm: 60,
        heightCm: 73,
        weightKg: 45,
      },
    ],
  },
  {
    name: 'Bàn nâng hạ điện IGM Smart Desk',
    description:
      'Khung nâng hạ điện 2 động cơ, nhớ 4 vị trí, chiều cao 62 - 127cm, tải trọng 120kg.',
    warrantyPeriod: '36 tháng',
    vat: 10,
    variants: deskVariants(
      'BAN-SMART',
      [
        { lengthCm: 140, price: 6_900_000, cost: 4_600_000, weightKg: 40 },
        { lengthCm: 160, price: 7_400_000, cost: 4_950_000, weightKg: 44 },
      ],
      DESK_FINISHES.slice(0, 2),
      { widthCm: 70, heightCm: 127 },
    ),
  },

  // ── Ghế ──────────────────────────────────────────────────────────────────────
  ...(
    [
      [
        'Ghế công thái học IGM 900',
        'GHE-900',
        3_000_000,
        1_900_000,
        'Tựa lưng lưới cao cấp, đỡ thắt lưng tự động, tựa đầu 3D, ngả 135°.',
      ],
      [
        'Ghế công thái học IGM 901',
        'GHE-901',
        2_500_000,
        1_550_000,
        'Đệm lưới, tay ghế 2D, ngả lưng khoá 3 nấc.',
      ],
      [
        'Ghế công thái học IGM 902',
        'GHE-902',
        2_800_000,
        1_750_000,
        'Điều chỉnh linh hoạt: tay 3D, trượt mặt ngồi, đỡ lưng chỉnh độ cao.',
      ],
    ] as const
  ).map(([name, base, price, cost, description]): SeedProduct => ({
    name,
    description,
    warrantyPeriod: '12 tháng',
    vat: 10,
    variants: CHAIR_COLORS.map((color) => ({
      sku: `${base}-${color.code}`,
      retailPrice: price,
      costPrice: cost,
      details: { Màu: color.name },
      lengthCm: 66,
      widthCm: 66,
      heightCm: 125,
      weightKg: 19,
    })),
  })),
  {
    name: 'Ghế văn phòng GVP 110',
    description: 'Ghế xoay văn phòng lưng lưới, chân nhựa, nâng hạ hơi.',
    warrantyPeriod: '12 tháng',
    vat: 10,
    variants: [
      {
        sku: 'GHE-GVP110-DEN',
        retailPrice: 1_299_000,
        costPrice: 780_000,
        details: { Màu: 'Đen' },
        lengthCm: 60,
        widthCm: 60,
        heightCm: 105,
        weightKg: 11,
      },
    ],
  },

  // ── Tủ kệ ────────────────────────────────────────────────────────────────────
  {
    name: 'Kệ sách Billy 6 tầng',
    description:
      'Kệ sách 6 tầng cao 2m15, MDF phủ Melamine, đợt kệ điều chỉnh được độ cao.',
    warrantyPeriod: '24 tháng',
    vat: 10,
    variants: [
      { w: 40, price: 1_500_000, cost: 900_000 },
      { w: 80, price: 2_200_000, cost: 1_300_000 },
      { w: 120, price: 3_100_000, cost: 1_850_000 },
    ].flatMap(({ w, price, cost }) =>
      [
        { code: 'TRANG', name: 'Trắng' },
        { code: 'OC', name: 'Vân óc chó' },
      ].map((color) => ({
        sku: `KE-BILLY-${color.code}-${w}`,
        retailPrice: price,
        costPrice: cost,
        details: { 'Chiều rộng': `${w}cm`, Màu: color.name },
        lengthCm: w,
        widthCm: 28,
        heightCm: 215,
        weightKg: Math.round(w * 0.45),
        allowCustomization: true,
        customLeadTimeDays: 10,
      })),
    ),
  },
  {
    name: 'Kệ để đồ 3 tầng có ngăn kéo',
    description: 'Kệ thấp 3 tầng, tầng dưới 2 ngăn kéo ray giảm chấn.',
    warrantyPeriod: '24 tháng',
    vat: 10,
    variants: [
      {
        sku: 'KE-3T-NK-TRANG',
        retailPrice: 2_500_000,
        costPrice: 1_500_000,
        details: { Màu: 'Trắng' },
        lengthCm: 80,
        widthCm: 35,
        heightCm: 110,
        weightKg: 32,
      },
      {
        sku: 'KE-3T-NK-SOI',
        retailPrice: 2_500_000,
        costPrice: 1_500_000,
        details: { Màu: 'Vân gỗ sồi' },
        lengthCm: 80,
        widthCm: 35,
        heightCm: 110,
        weightKg: 32,
      },
    ],
  },
  {
    name: 'Tủ kệ trắng có đèn LED',
    description:
      'Tủ kệ trưng bày cao 2m4, cánh kính, đèn LED âm từng tầng. Nhận đặt kích thước riêng.',
    warrantyPeriod: '24 tháng',
    vat: 10,
    variants: [
      {
        sku: 'TU-LED-TRANG-80',
        retailPrice: 3_500_000,
        costPrice: 2_200_000,
        details: { 'Chiều rộng': '80cm', Màu: 'Trắng' },
        lengthCm: 80,
        widthCm: 40,
        heightCm: 240,
        weightKg: 68,
        allowCustomization: true,
        customLeadTimeDays: 14,
      },
    ],
  },
  {
    name: 'Kệ tủ ngăn kéo ẩn dưới bàn',
    description: 'Tủ 3 ngăn kéo có bánh xe đặt gầm bàn, khoá ngăn trên cùng.',
    warrantyPeriod: '24 tháng',
    vat: 10,
    variants: [
      {
        sku: 'TU-NKA-DEN',
        retailPrice: 1_350_000,
        costPrice: 800_000,
        details: { Màu: 'Đen' },
        lengthCm: 40,
        widthCm: 45,
        heightCm: 60,
        weightKg: 18,
      },
      {
        sku: 'TU-NKA-TRANG',
        retailPrice: 1_350_000,
        costPrice: 800_000,
        details: { Màu: 'Trắng' },
        lengthCm: 40,
        widthCm: 45,
        heightCm: 60,
        weightKg: 18,
      },
    ],
  },

  // ── Phụ kiện ─────────────────────────────────────────────────────────────────
  {
    name: 'Kệ để màn hình',
    description: 'Kệ kê màn hình gỗ MDF, gầm để bàn phím.',
    warrantyPeriod: '6 tháng',
    vat: 10,
    variants: [
      { len: 60, price: 150_000, cost: 70_000 },
      { len: 100, price: 350_000, cost: 170_000 },
      { len: 140, price: 550_000, cost: 280_000 },
    ].map(({ len, price, cost }) => ({
      sku: `PK-KEMH-${len}`,
      retailPrice: price,
      costPrice: cost,
      details: { 'Chiều dài': `${len}cm` },
      lengthCm: len,
      widthCm: 22,
      heightCm: 10,
      weightKg: len / 25,
    })),
  },
  ...(
    [
      [
        'Chân chịu lực IGM',
        'PK-CHANCL',
        135_000,
        60_000,
        'Chân phụ chịu lực cho mặt bàn dài trên 1m8.',
      ],
      [
        'Hộp mica chia ngăn',
        'PK-MICA',
        250_000,
        110_000,
        'Hộp mica trong suốt chia 6 ngăn để bàn.',
      ],
      [
        'Ống luồn dây điện IGM',
        'PK-ONGDAY',
        50_000,
        18_000,
        'Ống gom dây điện dưới bàn, dài 1m.',
      ],
      [
        'Thanh giằng chống rung',
        'PK-GIANG',
        35_000,
        12_000,
        'Thanh giằng chéo chống rung cho khung bàn.',
      ],
      [
        'Khay bàn phím trượt',
        'PK-KHAYPHIM',
        290_000,
        130_000,
        'Khay bàn phím gắn gầm bàn, ray trượt bi.',
      ],
    ] as const
  ).map(([name, sku, price, cost, description]): SeedProduct => ({
    name,
    description,
    warrantyPeriod: '6 tháng',
    vat: 10,
    variants: [
      {
        sku,
        retailPrice: price,
        costPrice: cost,
        details: {},
      },
    ],
  })),
];

async function nextCodeCounter(tenantId: string): Promise<number> {
  const rows = await prisma.productItem.findMany({
    where: { tenantId, productCode: { startsWith: CODE_PREFIX } },
    select: { productCode: true },
  });
  let counter = 0;
  for (const { productCode } of rows) {
    const digits = productCode.slice(CODE_PREFIX.length);
    if (/^\d+$/.test(digits)) counter = Math.max(counter, Number(digits));
  }
  return counter;
}

async function seedProducts(tenantId: string) {
  let counter = await nextCodeCounter(tenantId);

  const allSkus = PRODUCTS.flatMap((p) => p.variants.map((v) => v.sku));
  const dupes = allSkus.filter((sku, i) => allSkus.indexOf(sku) !== i);
  if (dupes.length)
    throw new Error(`Duplicate SKUs in seed data: ${dupes.join(', ')}`);

  let created = 0;
  let skipped = 0;
  let variantCount = 0;

  for (const product of PRODUCTS) {
    const existing = await prisma.product.findFirst({
      where: { tenantId, name: product.name },
      select: { id: true },
    });
    if (existing) {
      skipped++;
      continue;
    }

    await prisma.$transaction(async (tx) => {
      const row = await tx.product.create({
        data: { tenantId, name: product.name, status: 'ACTIVE' },
      });
      for (const variant of product.variants) {
        await tx.productItem.create({
          data: {
            tenantId,
            productId: row.id,
            productName: product.name,
            productCode: `${CODE_PREFIX}${String(++counter).padStart(6, '0')}`,
            sku: variant.sku,
            description: product.description,
            retailPrice: variant.retailPrice,
            costPrice: variant.costPrice,
            warrantyPeriod: product.warrantyPeriod,
            vat: product.vat,
            allowCustomization: variant.allowCustomization ?? false,
            customLeadTimeDays: variant.customLeadTimeDays,
            lengthCm: variant.lengthCm,
            widthCm: variant.widthCm,
            heightCm: variant.heightCm,
            weightKg: variant.weightKg,
            details: {
              create: Object.entries(variant.details).map(
                ([name, value], position) => ({ name, value, position }),
              ),
            },
          },
        });
        variantCount++;
      }
    });
    created++;
  }

  console.log(
    `Furniture catalogue: ${created} products (${variantCount} variants) created, ${skipped} already present.`,
  );
}

async function main() {
  await assertCatalogSeeded();
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const { tenantId, ownerId } = await seedShop(passwordHash);
  const locations = await seedLocations(tenantId);
  await seedSubscription(tenantId, ownerId);
  const roleIds = await seedRoles(tenantId);
  await seedStaff(tenantId, ownerId, passwordHash, roleIds, locations);
  await seedProducts(tenantId);
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
