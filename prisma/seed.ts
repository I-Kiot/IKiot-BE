// Seeds the fixed PermissionCatalog every tenant-defined Role draws from. This taxonomy
// started as iKiotMS-BE's src/config/permissions.json (the union of every resource+action
// pair listed for the old 6 static roles) and has since grown - see the "added for the
// NestJS port" notes in CATALOG below. It is the app's contract, not tenant-editable data.
// Every `@Permissions(resource, action)` in code must have a row here or no role can ever
// be granted it. Run with `prisma db seed`.
import { PrismaClient } from '../generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import * as bcrypt from 'bcryptjs';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

// Dev-only platform admin. phoneNumber has no DB-level unique constraint (matches
// iKiotMS-BE - uniqueness is enforced app-side, see AuthService.register), so this uses
// find-then-create instead of upsert() to stay idempotent across re-seeds.
const ADMIN_PHONE = '0000000000';
const ADMIN_PASSWORD = 'password123';

async function seedAdminUser() {
  const existing = await prisma.user.findFirst({
    where: { phoneNumber: ADMIN_PHONE },
  });
  if (existing) {
    console.log('Admin account already exists, skipping.');
    return;
  }

  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
  await prisma.user.create({
    data: {
      tenantId: null, // ADMIN is platform-level, not scoped to any tenant
      phoneNumber: ADMIN_PHONE,
      password: passwordHash,
      systemRole: 'ADMIN',
      status: 'ACTIVE',
    },
  });
  console.log(`Seeded ADMIN account (phone ${ADMIN_PHONE}).`);
}

// Ported from iKiotMS-BE's src/seeders/plans.seeder.js - same 5 plans, same prices.
// Subscription's free-trial/upgrade/renew flows all fail without at least TRIAL existing.
const ALL_PLAN_FEATURES = [
  'stock_movement',
  'sales',
  'reports',
  'hr_management',
];

const PLANS = [
  {
    planName: 'Trial',
    planCode: 'TRIAL',
    price: 0,
    billingCycle: 'NONE',
    trialDays: 7,
    maxBranches: 2,
    maxWarehouses: 1,
    maxUsers: 2,
    maxProducts: 100,
    features: ALL_PLAN_FEATURES,
    description: 'Khám phá toàn bộ tính năng iKiot miễn phí trong 7 ngày.',
    displayFeatures: [
      'Dùng thử 7 ngày miễn phí',
      'Tối đa 2 chi nhánh',
      'Tối đa 1 kho',
      'Tối đa 100 sản phẩm',
      'Tối đa 2 nhân viên',
      'Bán hàng POS & báo cáo cơ bản',
    ],
    isPopular: false,
    isActive: true,
  },
  {
    planName: 'Plus',
    planCode: 'PLUS',
    price: 99000,
    billingCycle: 'MONTHLY',
    trialDays: 0,
    maxBranches: 3,
    maxWarehouses: 2,
    maxUsers: 5,
    maxProducts: 1000,
    features: ALL_PLAN_FEATURES,
    description:
      'Phù hợp cho chuỗi cửa hàng vừa và nhỏ có nhu cầu đồng bộ đa chi nhánh.',
    displayFeatures: [
      'Tối đa 3 chi nhánh',
      'Tối đa 2 kho',
      'Tối đa 1.000 sản phẩm',
      'Tối đa 5 nhân viên',
      'Quản lý kho & chuyển kho chi nhánh',
      'Quản lý nhân sự & bảng lương',
    ],
    isPopular: true,
    isActive: true,
  },
  {
    planName: 'Plus Năm',
    planCode: 'PLUS_YEARLY',
    price: 948000,
    billingCycle: 'YEARLY',
    trialDays: 0,
    maxBranches: 3,
    maxWarehouses: 2,
    maxUsers: 5,
    maxProducts: 1000,
    features: ALL_PLAN_FEATURES,
    description:
      'Phù hợp cho chuỗi cửa hàng vừa và nhỏ có nhu cầu đồng bộ đa chi nhánh.',
    displayFeatures: [
      'Tối đa 3 chi nhánh',
      'Tối đa 2 kho',
      'Tối đa 1.000 sản phẩm',
      'Tối đa 5 nhân viên',
      'Quản lý kho & chuyển kho chi nhánh',
      'Quản lý nhân sự & bảng lương',
    ],
    isPopular: true,
    isActive: true,
  },
  {
    planName: 'Pro',
    planCode: 'PRO',
    price: 299000,
    billingCycle: 'MONTHLY',
    trialDays: 0,
    maxBranches: -1,
    maxWarehouses: -1,
    maxUsers: -1,
    maxProducts: -1,
    features: ALL_PLAN_FEATURES,
    description: 'Giải pháp toàn diện không giới hạn cho chuỗi cửa hàng lớn.',
    displayFeatures: [
      'Không giới hạn chi nhánh',
      'Không giới hạn kho',
      'Không giới hạn sản phẩm',
      'Không giới hạn nhân viên',
      'Tất cả tính năng gói Plus',
      'Hỗ trợ ưu tiên',
    ],
    isPopular: false,
    isActive: true,
  },
  {
    planName: 'Pro Năm',
    planCode: 'PRO_YEARLY',
    price: 2868000,
    billingCycle: 'YEARLY',
    trialDays: 0,
    maxBranches: -1,
    maxWarehouses: -1,
    maxUsers: -1,
    maxProducts: -1,
    features: ALL_PLAN_FEATURES,
    description: 'Giải pháp toàn diện không giới hạn cho chuỗi cửa hàng lớn.',
    displayFeatures: [
      'Không giới hạn chi nhánh',
      'Không giới hạn kho',
      'Không giới hạn sản phẩm',
      'Không giới hạn nhân viên',
      'Tất cả tính năng gói Plus',
      'Hỗ trợ ưu tiên',
    ],
    isPopular: false,
    isActive: true,
  },
];

async function seedPlans() {
  for (const plan of PLANS) {
    await prisma.plan.upsert({
      where: { planCode: plan.planCode },
      update: plan,
      create: plan,
    });
  }
  console.log(`Seeded ${PLANS.length} plans.`);
}

const CATALOG: Record<string, { actions: string[]; label: string }> = {
  users: {
    actions: [
      'create',
      'read',
      'update',
      'delete',
      'assign_role',
      'create_staff',
    ],
    label: 'Tài khoản',
  },
  tenants: {
    actions: ['create', 'read', 'update', 'delete', 'suspend'],
    label: 'Doanh nghiệp',
  },
  products: {
    actions: ['create', 'read', 'update', 'delete'],
    label: 'Sản phẩm',
  },
  categories: {
    actions: ['create', 'read', 'update', 'delete'],
    label: 'Danh mục',
  },
  brands: {
    actions: ['create', 'read', 'update', 'delete'],
    label: 'Thương hiệu',
  },
  suppliers: {
    actions: ['create', 'read', 'update', 'delete', 'pay_debt'],
    label: 'Nhà cung cấp',
  },
  branches: {
    actions: ['create', 'read', 'update', 'delete', 'assign_manager'],
    label: 'Chi nhánh',
  },
  warehouses: {
    actions: ['create', 'read', 'update', 'delete', 'assign_manager'],
    label: 'Kho',
  },
  orders: {
    // 'delete' added for the NestJS port - the generated orders module exposes DELETE.
    // 'confirm' / 'assign' added for the order journey (2026-10-02): confirming an order
    // holds its stock, and naming the person in charge is a decision of its own.
    actions: [
      'create',
      'read',
      'update',
      'delete',
      'view_all',
      'pay_offline',
      'confirm',
      'assign',
      // Added 2026-10-04 with the revised order journey (docs/hanh-trinh-don-hang.md):
      // packing, shipping (the step that deducts stock) and confirming the cash a shipper
      // handed back are each a decision of their own, held by different people.
      'pack',
      'ship',
      'confirm_remittance',
    ],
    label: 'Đơn hàng',
  },
  inventory: {
    // 'create'/'delete' added for the NestJS port.
    actions: ['create', 'read', 'update', 'delete', 'view_all', 'manage'],
    label: 'Tồn kho',
  },
  subscriptions: {
    actions: ['read', 'update', 'manage'],
    label: 'Gói dịch vụ',
  },
  promotions: {
    actions: ['create', 'read', 'update', 'delete', 'calculate', 'apply'],
    label: 'Khuyến mãi',
  },
  reports: { actions: ['read', 'export'], label: 'Báo cáo' },
  cash_drawers: {
    // 'create'/'update'/'delete' added for the NestJS port - the old system only ever
    // opened and finalised a session, never edited one directly.
    actions: [
      'create',
      'read',
      'update',
      'delete',
      'open',
      'report',
      'finalize',
      'read_own',
    ],
    label: 'Ca thu ngân',
  },
  schedules: {
    actions: [
      'create',
      'read',
      'update',
      'delete',
      'read_all',
      'read_own',
      'readBR',
      'readWH',
    ],
    label: 'Lịch làm việc',
  },
  stock_movement: {
    // 'delete' added for the NestJS port.
    actions: [
      'create',
      'read',
      'update',
      'delete',
      'approve',
      'receive',
      'cancel',
    ],
    label: 'Xuất/nhập kho',
  },
  holidays: {
    actions: ['create', 'read', 'update', 'delete'],
    label: 'Ngày lễ',
  },
  profile: { actions: ['read'], label: 'Hồ sơ cá nhân' },

  // ── Resources with no equivalent in iKiotMS-BE's permissions.json ──────────────────
  // These modules had routes but no authorize() call at all in the old system - every
  // logged-in user could reach them. They get a real resource here so a tenant-defined
  // role can actually be scoped away from them.
  customers: {
    actions: ['create', 'read', 'update', 'delete'],
    label: 'Khách hàng',
  },
  tickets: {
    actions: ['create', 'read', 'update', 'delete'],
    label: 'Yêu cầu hỗ trợ',
  },
  cash_flows: {
    // Distinct from cash_drawers: a drawer is one cashier's shift, cash_flows is every
    // movement of tenant money (supplier payments, ...). The old system
    // only ever exposed it read-only under reports ('/stats/cashflow').
    actions: ['create', 'read', 'update', 'delete'],
    label: 'Dòng tiền',
  },
  ai_chat: {
    actions: ['create', 'read', 'update', 'delete'],
    label: 'Lịch sử chat AI',
  },

  // ── The order journey (2026-10-02, docs/order-flow.md) ─────────────────────────────
  // All added up front in Phase 0 so the parallel tracks never edit this file.
  production_requests: {
    // 'update' covers moving the status by hand (DRAFT → SENT → ... → COMPLETED).
    // 'receive' (2026-10-04): entering the quantity produced, which raises stock.
    actions: ['create', 'read', 'update', 'delete', 'receive'],
    label: 'Yêu cầu sản xuất',
  },
  fulfillments: {
    // 'verify' = confirming the packed goods are intact, which is what deducts the stock.
    actions: ['create', 'read', 'update', 'verify'],
    label: 'Đóng hàng',
  },
  shipments: {
    // 'deliver' is the shipper's own right: see their deliveries, upload proof, mark delivered.
    actions: ['create', 'read', 'update', 'deliver'],
    label: 'Giao hàng',
  },
  returns: {
    // The order's person in charge may also open a return without holding 'create'.
    actions: ['create', 'read', 'inspect', 'cancel'],
    label: 'Hoàn hàng',
  },
  sales_channels: {
    actions: ['create', 'read', 'update', 'delete'],
    label: 'Kênh bán (Shopee)',
  },
  payments: {
    actions: ['create', 'read', 'refund'],
    label: 'Thanh toán đơn',
  },
};

async function main() {
  const rows = Object.entries(CATALOG).flatMap(
    ([resource, { actions, label }]) =>
      actions.map((action) => ({ resource, action, label })),
  );

  for (const row of rows) {
    await prisma.permissionCatalog.upsert({
      where: {
        resource_action: { resource: row.resource, action: row.action },
      },
      update: { label: row.label },
      create: row,
    });
  }

  console.log(
    `Seeded ${rows.length} permission catalog entries across ${Object.keys(CATALOG).length} resources.`,
  );

  await seedAdminUser();
  await seedPlans();
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
