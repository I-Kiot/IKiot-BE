/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- body của supertest là any, cùng lý do eslint.config.mjs tắt nhóm luật này cho các file e2e. */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../../src/app.module';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';
import { PrismaService } from '../../src/prisma/prisma.service';
import {
  B360_PRODUCTS,
  IGM_COMBOS,
  IGM_PRODUCTS,
  type DemoCombo,
  type DemoProduct,
} from './catalog';

/**
 * Dữ liệu mẫu cho hai shop: "Nội thất IGM" và "360 Boutique". Chỉ dựng phần khung để tự thao tác tiếp trên màn hình: chi nhánh / kho, role, nhân viên (có tài khoản đăng nhập), danh mục, thương hiệu, nhà cung cấp và hàng hóa (kèm combo).
 * Không tạo khách hàng, phiếu nhập / chuyển kho, đơn hàng, doanh thu hay thu chi: tồn kho bằng 0, sổ sách trống.
 *
 * Mọi thứ đi qua route thật của API bằng tài khoản chủ shop, nên dữ liệu đúng như tạo trên màn hình.
 *
 * Chạy (DB local đã `prisma migrate reset` + `prisma db seed`): `pnpm run seed:demo`. Không chạy lại hai lần trên cùng DB: số điện thoại chủ shop đã có thì dừng.
 */
jest.setTimeout(30 * 60_000);

const PASSWORD = 'password123';
const ADMIN_PHONE = '0000000000';

// ---------------------------------------------------------------- tiện ích

/** PRNG có hạt giống: chạy lại ra cùng bộ dữ liệu. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min: number, max: number) =>
      min + Math.floor(next() * (max - min + 1)),
    pick: <T>(items: T[]): T => items[Math.floor(next() * items.length)],
    chance: (p: number) => next() < p,
    weighted: <T>(items: [T, number][]): T => {
      const total = items.reduce((n, [, w]) => n + w, 0);
      let r = next() * total;
      for (const [item, w] of items) {
        if ((r -= w) <= 0) return item;
      }
      return items[items.length - 1][0];
    },
  };
}
type Rng = ReturnType<typeof rng>;

const VN_OFFSET_H = 7;

/** Một thời điểm `daysAgo` ngày trước, lúc `hour:minute` giờ Việt Nam. */
function vnTime(daysAgo: number, hour: number, minute: number): Date {
  const now = new Date();
  const vnNow = new Date(now.getTime() + VN_OFFSET_H * 3600_000);
  return new Date(
    Date.UTC(
      vnNow.getUTCFullYear(),
      vnNow.getUTCMonth(),
      vnNow.getUTCDate() - daysAgo,
      hour - VN_OFFSET_H,
      minute,
    ),
  );
}

// ---------------------------------------------------------------- API

class Api {
  constructor(private readonly app: INestApplication<App>) {}

  async call<T = any>(
    token: string | null,
    method: 'get' | 'post' | 'patch' | 'put',
    path: string,
    body?: object,
  ): Promise<T> {
    let req = request(this.app.getHttpServer())[method](path);
    if (token) req = req.set('Authorization', `Bearer ${token}`);
    const res =
      method === 'get'
        ? await req.query(body ?? {})
        : await req.send(body ?? {});
    if (res.status >= 300) {
      const err = new Error(
        `${method.toUpperCase()} ${path} -> ${res.status} ${JSON.stringify(res.body).slice(0, 600)}`,
      ) as Error & { code?: string };
      err.code = res.body?.code;
      throw err;
    }
    return (res.body?.data ?? res.body) as T;
  }

  /** Đăng nhập; tài khoản chưa xác minh email thì đổi challenge lấy token bằng DEV_BYPASS (chỉ chạy ngoài production). */
  async login(identifier: string): Promise<string> {
    const data = await this.call<{
      accessToken?: string;
      requiresOtp?: boolean;
      challengeToken?: string;
    }>(null, 'post', '/auth/login', { identifier, password: PASSWORD });
    if (data.requiresOtp) return this.verifyOtp(data.challengeToken!);
    return data.accessToken!;
  }

  async verifyOtp(challengeToken: string): Promise<string> {
    const data = await this.call<{ accessToken: string }>(
      null,
      'post',
      '/auth/login/verify-otp',
      { challengeToken, otpCode: 'DEV_BYPASS' },
    );
    return data.accessToken;
  }
}

// ---------------------------------------------------------------- thiết lập shop

interface RoleDef {
  key: string;
  name: string;
  description: string;
  grants: Record<string, string[]>;
}

interface StaffDef {
  key: string;
  role: string;
  location: string;
  phone: string;
  lastName: string;
  firstName: string;
  gender: 'MALE' | 'FEMALE';
}

interface ShopDef {
  tenantName: string;
  owner: { phone: string; lastName: string; firstName: string };
  mainAddress: string;
  taxNumber: string;
  locations: {
    key: string;
    kind: 'branch' | 'warehouse';
    name: string;
    address: string;
    phone: string;
  }[];
  roles: RoleDef[];
  staff: StaffDef[];
  suppliers: {
    name: string;
    type: 'GOODS' | 'WORKSHOP';
    phone: string;
    address: string;
    contact: string;
  }[];
  products: DemoProduct[];
  combos: DemoCombo[];
}

interface Shop {
  tenantId: string;
  ownerId: string;
  ownerToken: string;
  locations: Record<string, string>;
  staffIds: Record<string, string>;
  skuIds: Record<string, string>;
  supplierIds: Record<string, string>;
}

async function setupShop(
  api: Api,
  def: ShopDef,
  adminToken: string,
  r: Rng,
): Promise<Shop> {
  const reg = await api.call(null, 'post', '/auth/register', {
    tenantName: def.tenantName,
    phoneNumber: def.owner.phone,
    email: `${def.owner.phone}@demo.ikiot.invalid`,
    password: PASSWORD,
    firstName: def.owner.firstName,
    lastName: def.owner.lastName,
  });
  const ownerToken = await api.verifyOtp(reg.challengeToken as string);
  const tenantId: string = reg.user.tenantId;
  const ownerId: string = reg.user.id;
  await api.call(ownerToken, 'post', '/subscription/free-trial');
  await api.call(adminToken, 'post', `/subscription/upgrade/${tenantId}`, {
    planCode: 'PRO',
  });
  await api.call(ownerToken, 'put', '/tenant/me', {
    mainAddress: def.mainAddress,
    taxNumber: def.taxNumber,
    phoneNumber: def.owner.phone,
  });

  const locations: Record<string, string> = {};
  for (const loc of def.locations) {
    const body: Record<string, unknown> = {
      name: loc.name,
      phoneNumber: [loc.phone],
      address: loc.address,
    };
    const row = await api.call(
      ownerToken,
      'post',
      loc.kind === 'branch' ? '/branches' : '/warehouses',
      body,
    );
    locations[loc.key] = row.id;
  }

  const roleIds: Record<string, string> = {};
  for (const role of def.roles) {
    const row = await api.call(ownerToken, 'post', '/roles', {
      name: role.name,
      description: role.description,
      permissions: Object.entries(role.grants).flatMap(([resource, actions]) =>
        actions.map((action) => ({ resource, action })),
      ),
    });
    roleIds[role.key] = row.id;
  }

  const staffIds: Record<string, string> = {};
  for (const s of def.staff) {
    const locKind = def.locations.find((l) => l.key === s.location)!.kind;
    const user = await api.call(ownerToken, 'post', '/users', {
      phoneNumber: s.phone,
      email: `${s.phone}@demo.ikiot.invalid`,
      roleId: roleIds[s.role],
      [locKind === 'branch' ? 'branchId' : 'warehouseId']:
        locations[s.location],
      firstName: s.firstName,
      lastName: s.lastName,
      hireDate: vnTime(r.int(120, 700), 9, 0).toISOString().slice(0, 10),
      profile: { gender: s.gender },
    });
    staffIds[s.key] = user.id;
    await api.call(ownerToken, 'post', `/users/${user.id}/account`, {
      newPassword: PASSWORD,
      reEnterPassword: PASSWORD,
    });
  }

  const categoryIds: Record<string, string> = {};
  const brandIds: Record<string, string> = {};
  for (const name of new Set(
    [...def.products, ...def.combos].map((p) => p.category),
  )) {
    categoryIds[name] = (
      await api.call(ownerToken, 'post', '/categories', { name })
    ).id;
  }
  for (const name of new Set(
    [...def.products, ...def.combos].map((p) => p.brand),
  )) {
    brandIds[name] = (
      await api.call(ownerToken, 'post', '/brands', { name })
    ).id;
  }
  const supplierIds: Record<string, string> = {};
  for (const s of def.suppliers) {
    const row = await api.call(ownerToken, 'post', '/suppliers', {
      supplierName: s.name,
      type: s.type,
      phoneNumber: s.phone,
      address: s.address,
      contactName: s.contact,
      creditLimit: 0,
    });
    supplierIds[s.name] = row.id;
  }

  const skuIds: Record<string, string> = {};
  for (const p of def.products) {
    const created = await api.call(ownerToken, 'post', '/products', {
      name: p.name,
      categoryId: categoryIds[p.category],
      brandId: brandIds[p.brand],
      isManufacturable: p.manufacturable ?? false,
      items: p.variants.map((variant) => ({
        productName: variant.name,
        sku: variant.sku,
        retailPrice: variant.retailPrice,
        costPrice: variant.costPrice,
        warrantyPeriod: p.warranty,
        productDetails: variant.details.map(([name, value]) => ({
          name,
          value,
        })),
        supplierIds: [supplierIds[p.supplier]],
      })),
    });
    for (const item of created.items as { id: string; sku: string }[]) {
      skuIds[item.sku] = item.id;
    }
  }
  for (const combo of def.combos) {
    const created = await api.call(ownerToken, 'post', '/products', {
      name: combo.name,
      productType: 'COMBO',
      categoryId: categoryIds[combo.category],
      brandId: brandIds[combo.brand],
      items: [
        {
          productName: combo.name,
          sku: combo.sku,
          retailPrice: combo.retailPrice,
          itemType: 'COMBO',
          comboComponents: combo.components.map((c) => ({
            componentItemId: skuIds[c.sku],
            quantity: c.quantity,
          })),
        },
      ],
    });
    skuIds[combo.sku] = created.items[0].id;
  }

  return {
    tenantId,
    ownerId,
    ownerToken,
    locations,
    staffIds,
    skuIds,
    supplierIds,
  };
}

// ---------------------------------------------------------------- Nội thất IGM

const IGM: ShopDef = {
  tenantName: 'Nội thất IGM',
  owner: { phone: '0981189856', lastName: 'Phạm Quốc', firstName: 'Huy' },
  mainAddress: '248 Phố Vọng, Phương Liệt, Thanh Xuân, Hà Nội',
  taxNumber: '0109123456',
  locations: [
    {
      key: 'WH_HN',
      kind: 'warehouse',
      name: 'Kho tổng Hà Nội',
      address: 'KCN Thạch Thất - Quốc Oai, Hà Nội',
      phone: '0912000091',
    },
    {
      key: 'WH_HCM',
      kind: 'warehouse',
      name: 'Kho Hồ Chí Minh',
      address: '120 Kinh Dương Vương, Bình Tân, TP. Hồ Chí Minh',
      phone: '0912000092',
    },
    {
      key: 'TX',
      kind: 'branch',
      name: 'Showroom Thanh Xuân',
      address: '248 Phố Vọng, Phương Liệt, Thanh Xuân, Hà Nội',
      phone: '0912000093',
    },
    {
      key: 'CG',
      kind: 'branch',
      name: 'Showroom Cầu Giấy',
      address: '16B20 ngõ 1 Nghĩa Tân, Cầu Giấy, Hà Nội',
      phone: '0912000094',
    },
    {
      key: 'Q11',
      kind: 'branch',
      name: 'Showroom Quận 11',
      address: '3B hẻm 152/54 Lạc Long Quân, Quận 11, TP. Hồ Chí Minh',
      phone: '0912000095',
    },
  ],
  roles: [
    {
      key: 'MANAGER',
      name: 'Quản lý showroom',
      description:
        'Phụ trách một showroom: theo dõi, sửa, huỷ đơn của showroom; xử lý hoàn hàng; xem báo cáo',
      grants: {
        orders: ['create', 'read', 'update', 'assign', 'pay_offline'],
        customers: ['create', 'read', 'update'],
        returns: ['create', 'read', 'inspect', 'cancel'],
        shipments: ['read'],
        inventory: ['read'],
        stock_movement: ['create', 'read'],
        promotions: ['read', 'calculate', 'apply'],
        payments: ['read'],
        reports: ['read', 'export'],
        users: ['read'],
      },
    },
    {
      key: 'SALE',
      name: 'Nhân viên bán hàng',
      description:
        'Tư vấn tại showroom, lên đơn, nhận cọc, giao hàng tại quầy cho khách tới lấy',
      grants: {
        orders: ['create', 'read', 'update'],
        customers: ['create', 'read', 'update'],
        returns: ['create', 'read'],
        inventory: ['read'],
        promotions: ['read', 'calculate', 'apply'],
        shipments: ['read'],
        payments: ['read'],
      },
    },
    {
      key: 'WAREHOUSE',
      name: 'Thủ kho',
      description:
        'Nhập hàng, chuyển kho, đóng gói đơn, giao cho shipper và xác nhận xuất kho',
      grants: {
        // Kho tổng phục vụ mọi chi nhánh: xem được đơn của các chi nhánh để đóng gói và giao.
        orders: ['read', 'view_all', 'pack', 'ship'],
        shipments: ['create', 'read', 'update'],
        inventory: ['read', 'update'],
        stock_movement: [
          'create',
          'read',
          'update',
          'approve',
          'receive',
          'cancel',
        ],
        suppliers: ['read'],
        production_requests: ['read'],
        production: ['receive'],
      },
    },
    {
      key: 'DRIVER',
      name: 'Nhân viên giao hàng',
      description:
        'Nhận hàng tại kho, giao và lắp đặt tại nhà khách, thu tiền còn lại',
      grants: { orders: ['read'], shipments: ['read', 'deliver'] },
    },
    {
      key: 'ACCOUNTANT',
      name: 'Kế toán',
      description:
        'Xác nhận tiền shipper nộp, đối soát, trả công nợ nhà cung cấp, xem và xuất báo cáo',
      grants: {
        orders: ['read', 'view_all', 'confirm_cash'],
        payments: ['read', 'refund'],
        cash_flows: ['read'],
        suppliers: ['read', 'pay_debt'],
        reports: ['read', 'export'],
        cash_drawers: ['read', 'report'],
      },
    },
    {
      key: 'CS',
      name: 'Chăm sóc khách hàng',
      description: 'Tiếp nhận đổi trả, kiểm hàng hoàn, hoàn tiền cho khách',
      grants: {
        orders: ['read', 'view_all'],
        returns: ['create', 'read', 'inspect', 'cancel'],
        customers: ['read', 'update'],
        payments: ['read'],
      },
    },
  ],
  staff: [
    {
      key: 'mgrTX',
      role: 'MANAGER',
      location: 'TX',
      phone: '0912000011',
      lastName: 'Trần Minh',
      firstName: 'Đức',
      gender: 'MALE',
    },
    {
      key: 'saleTX1',
      role: 'SALE',
      location: 'TX',
      phone: '0912000012',
      lastName: 'Nguyễn Thu',
      firstName: 'Hà',
      gender: 'FEMALE',
    },
    {
      key: 'saleTX2',
      role: 'SALE',
      location: 'TX',
      phone: '0912000013',
      lastName: 'Lê Văn',
      firstName: 'Nam',
      gender: 'MALE',
    },
    {
      key: 'saleCG',
      role: 'SALE',
      location: 'CG',
      phone: '0912000014',
      lastName: 'Đỗ Thị',
      firstName: 'Mai',
      gender: 'FEMALE',
    },
    {
      key: 'mgrQ11',
      role: 'MANAGER',
      location: 'Q11',
      phone: '0912000015',
      lastName: 'Võ Thanh',
      firstName: 'Tâm',
      gender: 'MALE',
    },
    {
      key: 'saleQ11',
      role: 'SALE',
      location: 'Q11',
      phone: '0912000016',
      lastName: 'Huỳnh Ngọc',
      firstName: 'Trâm',
      gender: 'FEMALE',
    },
    {
      key: 'whHN',
      role: 'WAREHOUSE',
      location: 'WH_HN',
      phone: '0912000021',
      lastName: 'Bùi Văn',
      firstName: 'Long',
      gender: 'MALE',
    },
    {
      key: 'whHCM',
      role: 'WAREHOUSE',
      location: 'WH_HCM',
      phone: '0912000022',
      lastName: 'Hoàng Văn',
      firstName: 'Phúc',
      gender: 'MALE',
    },
    {
      key: 'drvHN1',
      role: 'DRIVER',
      location: 'WH_HN',
      phone: '0912000031',
      lastName: 'Ngô Văn',
      firstName: 'Tài',
      gender: 'MALE',
    },
    {
      key: 'drvHN2',
      role: 'DRIVER',
      location: 'WH_HN',
      phone: '0912000032',
      lastName: 'Đặng Quang',
      firstName: 'Vinh',
      gender: 'MALE',
    },
    {
      key: 'drvHCM',
      role: 'DRIVER',
      location: 'WH_HCM',
      phone: '0912000033',
      lastName: 'Lý Văn',
      firstName: 'Hậu',
      gender: 'MALE',
    },
    {
      key: 'acc',
      role: 'ACCOUNTANT',
      location: 'TX',
      phone: '0912000041',
      lastName: 'Phan Thị',
      firstName: 'Lan',
      gender: 'FEMALE',
    },
    {
      key: 'cs',
      role: 'CS',
      location: 'TX',
      phone: '0912000042',
      lastName: 'Vũ Thị',
      firstName: 'Hồng',
      gender: 'FEMALE',
    },
  ],
  suppliers: [
    {
      name: 'Công ty TNHH Nội thất Phương Nam',
      type: 'GOODS',
      phone: '0243555012',
      address: 'KCN Phú Nghĩa, Chương Mỹ, Hà Nội',
      contact: 'Anh Quyết',
    },
    {
      name: 'Sihoo Việt Nam',
      type: 'GOODS',
      phone: '0283777245',
      address: 'Quận Tân Bình, TP. Hồ Chí Minh',
      contact: 'Chị Ngân',
    },
    {
      name: 'Xưởng mộc Hoài Đức',
      type: 'WORKSHOP',
      phone: '0243666180',
      address: 'Vân Canh, Hoài Đức, Hà Nội',
      contact: 'Anh Thịnh',
    },
  ],
  products: IGM_PRODUCTS,
  combos: IGM_COMBOS,
};

// ---------------------------------------------------------------- 360 Boutique

const B360: ShopDef = {
  tenantName: '360 Boutique',
  owner: { phone: '0325299245', lastName: 'Lương Hoàng', firstName: 'Anh' },
  mainAddress: '82 Thái Hà, Đống Đa, Hà Nội',
  taxNumber: '0106789123',
  locations: [
    {
      key: 'WH',
      kind: 'warehouse',
      name: 'Kho tổng 360',
      address: '27 Phan Trọng Tuệ, Thanh Trì, Hà Nội',
      phone: '0936000091',
    },
    {
      key: 'TH',
      kind: 'branch',
      name: '360 Thái Hà',
      address: '82 Thái Hà, Đống Đa, Hà Nội',
      phone: '0936000092',
    },
    {
      key: 'DCV',
      kind: 'branch',
      name: '360 Đại Cồ Việt',
      address: '45 Đại Cồ Việt, Hai Bà Trưng, Hà Nội',
      phone: '0936000093',
    },
    {
      key: 'CG',
      kind: 'branch',
      name: '360 Cầu Giấy',
      address: '168 Cầu Giấy, Cầu Giấy, Hà Nội',
      phone: '0936000094',
    },
  ],
  roles: [
    {
      key: 'STORE_MANAGER',
      name: 'Cửa hàng trưởng',
      description:
        'Điều hành một cửa hàng: bán, đổi trả, nhận hàng chuyển về, chốt két cuối ngày, xem báo cáo cửa hàng',
      grants: {
        orders: ['create', 'read', 'update', 'pay_offline'],
        customers: ['create', 'read', 'update'],
        returns: ['create', 'read', 'inspect'],
        promotions: ['read', 'calculate', 'apply'],
        inventory: ['read'],
        stock_movement: ['create', 'read', 'receive'],
        cash_drawers: ['open', 'read', 'finalize', 'report'],
        payments: ['read'],
        reports: ['read', 'export'],
        users: ['read'],
      },
    },
    {
      key: 'CASHIER',
      name: 'Thu ngân - bán hàng',
      description: 'Bán tại quầy, thu tiền, áp khuyến mãi, nhận ca két',
      grants: {
        orders: ['create', 'read'],
        customers: ['create', 'read'],
        promotions: ['read', 'calculate', 'apply'],
        inventory: ['read'],
        cash_drawers: ['open', 'read'],
      },
    },
    {
      key: 'ONLINE',
      name: 'Nhân viên bán online',
      description: 'Chốt đơn qua fanpage / Zalo, lên đơn giao từ kho tổng',
      grants: {
        orders: ['create', 'read', 'update'],
        customers: ['create', 'read', 'update'],
        returns: ['create', 'read'],
        inventory: ['read'],
        shipments: ['read'],
        promotions: ['read', 'calculate', 'apply'],
      },
    },
    {
      key: 'WAREHOUSE',
      name: 'Thủ kho',
      description:
        'Nhập hàng từ xưởng, chia hàng về cửa hàng, đóng gói đơn online',
      grants: {
        // Kho tổng phục vụ mọi chi nhánh: xem được đơn của các chi nhánh để đóng gói và giao.
        orders: ['read', 'view_all', 'pack', 'ship'],
        shipments: ['create', 'read', 'update'],
        inventory: ['read', 'update'],
        stock_movement: [
          'create',
          'read',
          'update',
          'approve',
          'receive',
          'cancel',
        ],
        suppliers: ['read'],
      },
    },
    {
      key: 'DRIVER',
      name: 'Nhân viên giao hàng',
      description: 'Giao đơn online nội thành, thu tiền COD',
      grants: { orders: ['read'], shipments: ['read', 'deliver'] },
    },
    {
      key: 'ACCOUNTANT',
      name: 'Kế toán',
      description:
        'Xác nhận tiền COD, đối soát két các cửa hàng, công nợ xưởng, báo cáo',
      grants: {
        orders: ['read', 'view_all', 'confirm_cash'],
        payments: ['read', 'refund'],
        cash_flows: ['read'],
        suppliers: ['read', 'pay_debt'],
        reports: ['read', 'export'],
        cash_drawers: ['read', 'report'],
      },
    },
  ],
  staff: [
    {
      key: 'mgrTH',
      role: 'STORE_MANAGER',
      location: 'TH',
      phone: '0936000011',
      lastName: 'Nguyễn Tuấn',
      firstName: 'Kiệt',
      gender: 'MALE',
    },
    {
      key: 'cashTH1',
      role: 'CASHIER',
      location: 'TH',
      phone: '0936000012',
      lastName: 'Trần Thu',
      firstName: 'Trang',
      gender: 'FEMALE',
    },
    {
      key: 'cashTH2',
      role: 'CASHIER',
      location: 'TH',
      phone: '0936000013',
      lastName: 'Phạm Đức',
      firstName: 'Anh',
      gender: 'MALE',
    },
    {
      key: 'mgrDCV',
      role: 'STORE_MANAGER',
      location: 'DCV',
      phone: '0936000014',
      lastName: 'Lê Hải',
      firstName: 'Yến',
      gender: 'FEMALE',
    },
    {
      key: 'cashDCV1',
      role: 'CASHIER',
      location: 'DCV',
      phone: '0936000015',
      lastName: 'Hoàng Minh',
      firstName: 'Quân',
      gender: 'MALE',
    },
    {
      key: 'cashDCV2',
      role: 'CASHIER',
      location: 'DCV',
      phone: '0936000016',
      lastName: 'Đinh Phương',
      firstName: 'Thảo',
      gender: 'FEMALE',
    },
    {
      key: 'mgrCG',
      role: 'STORE_MANAGER',
      location: 'CG',
      phone: '0936000017',
      lastName: 'Vũ Thành',
      firstName: 'Đạt',
      gender: 'MALE',
    },
    {
      key: 'cashCG1',
      role: 'CASHIER',
      location: 'CG',
      phone: '0936000018',
      lastName: 'Bùi Ngọc',
      firstName: 'Linh',
      gender: 'FEMALE',
    },
    {
      key: 'cashCG2',
      role: 'CASHIER',
      location: 'CG',
      phone: '0936000019',
      lastName: 'Ngô Quang',
      firstName: 'Huy',
      gender: 'MALE',
    },
    {
      key: 'online',
      role: 'ONLINE',
      location: 'TH',
      phone: '0936000021',
      lastName: 'Đặng Minh',
      firstName: 'Châu',
      gender: 'FEMALE',
    },
    {
      key: 'wh',
      role: 'WAREHOUSE',
      location: 'WH',
      phone: '0936000031',
      lastName: 'Trịnh Văn',
      firstName: 'Sơn',
      gender: 'MALE',
    },
    {
      key: 'drv',
      role: 'DRIVER',
      location: 'WH',
      phone: '0936000032',
      lastName: 'Mai Văn',
      firstName: 'Thắng',
      gender: 'MALE',
    },
    {
      key: 'acc',
      role: 'ACCOUNTANT',
      location: 'TH',
      phone: '0936000041',
      lastName: 'Dương Thị',
      firstName: 'Hằng',
      gender: 'FEMALE',
    },
  ],
  suppliers: [
    {
      name: 'Xưởng may Hà Đông',
      type: 'GOODS',
      phone: '0243344556',
      address: 'Văn Phú, Hà Đông, Hà Nội',
      contact: 'Chị Hòa',
    },
    {
      name: 'Xưởng giày túi Phú Xuyên',
      type: 'GOODS',
      phone: '0243399887',
      address: 'Phú Xuyên, Hà Nội',
      contact: 'Anh Toàn',
    },
  ],
  products: B360_PRODUCTS,
  combos: [],
};

// ---------------------------------------------------------------- chạy

describe('demo shops seed', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('creates Nội thất IGM and 360 Boutique with staff and products', async () => {
    for (const phoneNumber of [IGM.owner.phone, B360.owner.phone]) {
      if (await prisma.user.findFirst({ where: { phoneNumber } })) {
        throw new Error(
          `${phoneNumber} đã có trong DB: seed mẫu đã chạy rồi. Reset DB trước khi chạy lại.`,
        );
      }
    }
    const api = new Api(app);
    const adminToken = await api.login(ADMIN_PHONE);
    for (const [seed, def] of [
      [20261115, IGM],
      [360360, B360],
    ] as const) {
      const shop = await setupShop(api, def, adminToken, rng(seed));
      console.log(
        `${def.tenantName}: ${Object.keys(shop.locations).length} địa điểm, ${Object.keys(shop.staffIds).length} nhân viên, ${Object.keys(shop.skuIds).length} SKU.`,
      );
    }
  });
});
