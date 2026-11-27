// Seed danh mục quyền cố định; mọi `@Permissions` phải có ở đây.
import { PrismaClient } from '../generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import * as bcrypt from 'bcryptjs';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

// Admin dev nội bộ, tìm trước rồi tạo.
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
      tenantId: null, // ADMIN thuộc cấp nền tảng, không gắn tenant
      phoneNumber: ADMIN_PHONE,
      password: passwordHash,
      systemRole: 'ADMIN',
      status: 'ACTIVE',
      // Tài khoản dev không có email để nhận OTP: coi như đã xác minh để đăng nhập thẳng.
      emailVerifiedAt: new Date(),
    },
  });
  console.log(`Seeded ADMIN account (phone ${ADMIN_PHONE}).`);
}

// Luồng dùng thử/nâng cấp/gia hạn của Subscription đều lỗi nếu chưa có gói TRIAL.
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
      'Quản lý nhân sự & lịch làm việc',
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
      'Quản lý nhân sự & lịch làm việc',
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

/** Mô tả quyền hiện ở màn Vai trò. */
const CATALOG: Record<
  string,
  { actions: string[]; label: string; descriptions?: Record<string, string> }
> = {
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
    // `read_own` là quyền nền nhân viên, màn Vai trò ẩn.
    actions: [
      'create',
      'read',
      'update',
      'delete',
      'assign_manager',
      'read_own',
    ],
    label: 'Chi nhánh',
  },
  warehouses: {
    actions: [
      'create',
      'read',
      'update',
      'delete',
      'assign_manager',
      'read_own',
    ],
    label: 'Kho',
  },
  orders: {
    // 'confirm' và 'assign' là hai quyền riêng.
    actions: [
      'create',
      'read',
      'update',
      'delete',
      'view_all',
      'pay_offline',
      'confirm',
      'assign',
      // 'pack', 'ship', 'confirm_cash' là ba quyền riêng.
      'pack',
      'ship',
      'confirm_cash',
    ],
    label: 'Đơn hàng',
    descriptions: {
      // Người phụ trách không được miễn ở bước này (ASSIGNEE_MAY_SHIP).
      ship: 'Bấm "Bắt đầu vận chuyển" ở đơn hàng (Đã lấy hàng → Đang vận chuyển), tức xác nhận hàng đã giao cho ĐVVC: trừ tồn kho và gỡ phần hàng đang giữ cho đơn. Chỉ làm được tại kho xuất mình được phân công. Người phụ trách đơn cũng cần quyền này.',
    },
  },
  inventory: {
    actions: [
      'create',
      'read',
      'update',
      'delete',
      'view_all',
      'manage',
      'manage_damaged',
    ],
    label: 'Tồn kho',
    descriptions: {
      manage_damaged:
        'Đánh dấu hàng hỏng, xác nhận sửa xong và huỷ / thanh lý hàng hỏng tại nơi mình làm việc. Hàng hỏng nằm ngoài tồn bán được.',
    },
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
    // Hệ thống cũ chỉ mở và chốt ca, không sửa ca trực tiếp.
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

  // ── Resource mới, cũ không kiểm quyền ──
  customers: {
    actions: ['create', 'read', 'update', 'delete'],
    label: 'Khách hàng',
  },
  tickets: {
    actions: ['create', 'read', 'update', 'delete'],
    label: 'Yêu cầu hỗ trợ',
  },
  cash_flows: {
    // Mọi dòng tiền của tenant.
    actions: ['create', 'read', 'update', 'delete'],
    label: 'Dòng tiền',
  },
  ai_chat: {
    actions: ['create', 'read', 'update', 'delete'],
    label: 'Lịch sử chat AI',
  },

  // ── Hành trình đơn hàng ──
  production_requests: {
    actions: ['create', 'read', 'update', 'delete'],
    label: 'Yêu cầu sản xuất',
  },
  production: {
    // 'receive' tăng tồn khi nhận hàng xưởng; 'deliver' tự cấp cho tài khoản gắn xưởng.
    actions: ['receive', 'deliver'],
    label: 'Nhập hàng sản xuất',
  },
  fulfillments: {
    // 'verify' = xác nhận hàng đã đóng còn nguyên vẹn; đây là bước trừ tồn kho.
    actions: ['create', 'read', 'update', 'verify'],
    label: 'Đóng hàng',
  },
  shipments: {
    actions: ['create', 'read', 'update', 'deliver'],
    label: 'Giao hàng',
  },
  returns: {
    // Người phụ trách đơn cũng được mở đơn hoàn mà không cần 'create'.
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
    ([resource, { actions, label, descriptions }]) =>
      actions.map((action) => ({
        resource,
        action,
        label,
        description: descriptions?.[action] ?? null,
      })),
  );

  for (const row of rows) {
    await prisma.permissionCatalog.upsert({
      where: {
        resource_action: { resource: row.resource, action: row.action },
      },
      update: { label: row.label, description: row.description },
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
