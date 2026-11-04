// Tài khoản, địa điểm, role để test thủ công hành trình đơn (chép từ docs/tai-khoan-test-hanh-trinh.md, phần 1.2–1.4). Chạy sau `prisma db seed`, trước seed-furniture-test.ts.
// Chạy lại an toàn: thứ đã có thì giữ nguyên. Chỉ dữ liệu dev, mật khẩu là DEMO_PASSWORD.
import 'dotenv/config';
import { PrismaClient } from '../generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import * as bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const DEMO_PASSWORD = 'password123';
const SHOP_NAME = 'Nội thất Demo';
const OWNER = {
  phoneNumber: '0981189856',
  lastName: 'Nguyễn Thị',
  firstName: 'Demo',
};

type LocationKey = 'DAMAGED' | 'HANOI' | 'HCM';

const LOCATIONS: {
  key: LocationKey;
  name: string;
  type: 'BRANCH' | 'WAREHOUSE';
  isSellable: boolean;
}[] = [
  // Tạo trước để L2 trỏ được tới nó làm kho hàng hỏng.
  {
    key: 'DAMAGED',
    name: 'Kho hàng hỏng',
    type: 'WAREHOUSE',
    isSellable: false,
  },
  { key: 'HANOI', name: 'CN Hà Nội', type: 'BRANCH', isSellable: true },
  { key: 'HCM', name: 'CN Hồ Chí Minh', type: 'BRANCH', isSellable: true },
];

/**
 * Đúng các quyền được tick theo từng role trong file test. Bộ quyền STAFF cơ bản do JwtStrategy cấp và bị loại khỏi những gì role lưu, nên không xuất hiện ở đây.
 */
const ROLES: {
  code: string;
  name: string;
  permissions: [string, string[]][];
}[] = [
  {
    code: 'R1',
    name: 'R1 – Bán hàng',
    permissions: [
      ['orders', ['create', 'read', 'update']],
      ['customers', ['create', 'read', 'update']],
      ['returns', ['create', 'read']],
      ['users', ['read']],
    ],
  },
  {
    code: 'R2',
    name: 'R2 – Phụ trách đơn',
    permissions: [
      ['orders', ['read']],
      ['shipments', ['read']],
    ],
  },
  {
    code: 'R3',
    name: 'R3 – Kho',
    permissions: [
      ['orders', ['read', 'pack', 'ship']],
      ['shipments', ['create', 'read', 'update']],
      ['inventory', ['read']],
      // `approve` là tick tùy chọn của file test; cấp để K11 bước 3 và kiểm kho chạy được bằng tài khoản kho.
      ['stock_movement', ['create', 'read', 'update', 'receive', 'approve']],
      ['production_requests', ['read']],
      ['production', ['receive']],
    ],
  },
  {
    code: 'R4',
    name: 'R4 – Shipper',
    permissions: [['shipments', ['deliver']]],
  },
  {
    code: 'R5',
    name: 'R5 – Kế toán',
    permissions: [['orders', ['read', 'confirm_cash']]],
  },
  {
    code: 'R6',
    name: 'R6 – Sản xuất',
    permissions: [
      ['production_requests', ['create', 'read', 'update', 'delete']],
      ['suppliers', ['create', 'read', 'update']],
    ],
  },
  {
    code: 'R7',
    name: 'R7 – Hoàn hàng',
    permissions: [
      ['orders', ['read']],
      ['returns', ['read', 'inspect', 'cancel']],
    ],
  },
];

/** profile: app hiển thị "họ tên", ví dụ "Sale Hà Nội". */
const STAFF: {
  code: string;
  lastName: string;
  firstName: string;
  phoneNumber: string;
  role: string;
  location: LocationKey;
}[] = [
  {
    code: 'U1',
    lastName: 'Sale',
    firstName: 'Hà Nội',
    phoneNumber: '0901189801',
    role: 'R1',
    location: 'HANOI',
  },
  {
    code: 'U2',
    lastName: 'Phụ Trách',
    firstName: 'Đơn',
    phoneNumber: '0901189802',
    role: 'R2',
    location: 'HANOI',
  },
  {
    code: 'U3',
    lastName: 'Kho',
    firstName: 'Hà Nội',
    phoneNumber: '0901189803',
    role: 'R3',
    location: 'HANOI',
  },
  {
    code: 'U4',
    lastName: 'Shipper',
    firstName: 'Một',
    phoneNumber: '0901189804',
    role: 'R4',
    location: 'HANOI',
  },
  {
    code: 'U5',
    lastName: 'Kho',
    firstName: 'Hồ Chí Minh',
    phoneNumber: '0901189805',
    role: 'R3',
    location: 'HCM',
  },
  {
    code: 'U6',
    lastName: 'Shipper',
    firstName: 'Hai',
    phoneNumber: '0901189806',
    role: 'R4',
    location: 'HANOI',
  },
  {
    code: 'U7',
    lastName: 'Kế',
    firstName: 'Toán',
    phoneNumber: '0901189807',
    role: 'R5',
    location: 'HANOI',
  },
  {
    code: 'U8',
    lastName: 'Sản',
    firstName: 'Xuất',
    phoneNumber: '0901189808',
    role: 'R6',
    location: 'HANOI',
  },
  {
    code: 'U9',
    lastName: 'Xử Lý',
    firstName: 'Hoàn',
    phoneNumber: '0901189809',
    role: 'R7',
    location: 'HANOI',
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
  const existing = await prisma.user.findFirst({
    where: { phoneNumber: OWNER.phoneNumber },
    select: { id: true, tenantId: true },
  });
  if (existing?.tenantId) {
    console.log(`Owner ${OWNER.phoneNumber} already exists, reusing the shop.`);
    return { tenantId: existing.tenantId, ownerId: existing.id };
  }
  return prisma.$transaction(async (tx) => {
    const tenant = await tx.tenant.create({
      data: { name: SHOP_NAME, phoneNumber: OWNER.phoneNumber },
    });
    const owner = await tx.user.create({
      data: {
        tenantId: tenant.id,
        phoneNumber: OWNER.phoneNumber,
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

/** PRO (không giới hạn quota) một năm, đúng như file test. */
async function seedSubscription(tenantId: string, ownerId: string) {
  if (await prisma.subscription.findFirst({ where: { tenantId } })) return;
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
          note: 'Test seed',
        },
      },
    },
  });
  console.log('Assigned PRO subscription for one year.');
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
    // Dòng branch/warehouse nhận đúng id của Location, như LocationService.
    const id = randomUUID();
    const specialization = { create: { id, tenantId } };
    await prisma.location.create({
      data: {
        id,
        tenantId,
        name: loc.name,
        type: loc.type,
        isSellable: loc.isSellable,
        ...(loc.type === 'BRANCH'
          ? { branch: specialization }
          : { warehouse: specialization }),
      },
    });
    ids[loc.key] = id;
  }
  // L2 trỏ L1 làm kho hàng hỏng; L3 cũng vậy để đơn trả về có chỗ đặt hàng hỏng. defaultFulfillmentLocationId cố ý để null (file test, phần 0 mục 1: không ai đặt được nên chi nhánh tự xuất hàng).
  await prisma.location.updateMany({
    where: { id: { in: [ids.HANOI, ids.HCM] } },
    data: { damagedLocationId: ids.DAMAGED },
  });
  return ids;
}

async function seedRoles(tenantId: string): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const role of ROLES) {
    const existing = await prisma.role.findUnique({
      where: { tenantId_name: { tenantId, name: role.name } },
      select: { id: true },
    });
    if (existing) {
      ids.set(role.code, existing.id);
      continue;
    }
    const row = await prisma.role.create({
      data: {
        tenantId,
        name: role.name,
        permissions: {
          create: role.permissions.flatMap(([resource, actions]) =>
            actions.map((action) => ({ resource, action })),
          ),
        },
      },
    });
    ids.set(role.code, row.id);
  }
  console.log(`Roles ready: ${ROLES.map((r) => r.name).join(', ')}.`);
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
  console.log(
    `Staff accounts: ${created} created, ${STAFF.length - created} already present.`,
  );
}

async function main() {
  await assertCatalogSeeded();
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const { tenantId, ownerId } = await seedShop(passwordHash);
  await seedSubscription(tenantId, ownerId);
  const locations = await seedLocations(tenantId);
  const roleIds = await seedRoles(tenantId);
  await seedStaff(tenantId, ownerId, passwordHash, roleIds, locations);
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
