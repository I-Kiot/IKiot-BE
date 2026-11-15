/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call -- body của supertest là any, cùng lý do eslint.config.mjs tắt nhóm luật này cho các file e2e. */
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
 * Dữ liệu mẫu cho hai shop: "Nội thất IGM" (bán qua đơn, xuất từ kho, giao bằng shipper của shop) và "360 Boutique" (bán ở quầy các chi nhánh, một ít đơn online xuất từ kho).
 *
 * Mọi thứ đi qua route thật của API, bằng tài khoản của đúng người làm việc đó (nhân viên bán tạo đơn, thủ kho đóng gói, shipper giao, kế toán xác nhận tiền), nên sổ doanh thu, sổ kho, thu chi và lịch sử đơn đúng như dùng thật.
 * Riêng thời gian: API ghi mọi thứ ở "bây giờ", nên sau mỗi đơn script dời toàn bộ dấu thời gian của đơn đó về một ngày trong 60 ngày qua (`shiftOrder`), và dời phần thiết lập (nhập kho, hàng hóa, nhân viên) về trước đó.
 * Việc dời giờ phải tạm tắt bốn trigger chặn sửa (sổ doanh thu, lịch sử đơn, sổ công nợ NCC), bật lại ngay khi xong. Đây là ngoại lệ chỉ dành cho dữ liệu mẫu, không phải cách app ghi sổ.
 *
 * Chạy (DB local đã `prisma migrate reset` + `prisma db seed`): `pnpm run seed:demo`. Không chạy lại hai lần trên cùng DB: số điện thoại chủ shop đã có thì dừng.
 */
jest.setTimeout(60 * 60_000);

const PASSWORD = 'password123';
const ADMIN_PHONE = '0000000000';
const DAYS = 60;

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

/** Giờ bán hàng: đông buổi trưa và tối, cuối tuần nhiều hơn. */
function salesMoment(r: Rng, minDay: number, maxDay: number): Date {
  for (;;) {
    const day = r.int(minDay, maxDay);
    const hour = r.weighted<number>([
      [9, 2],
      [10, 4],
      [11, 5],
      [12, 4],
      [13, 3],
      [14, 3],
      [15, 3],
      [16, 4],
      [17, 5],
      [18, 6],
      [19, 7],
      [20, 6],
      [21, 3],
    ]);
    const at = vnTime(day, hour, r.int(0, 59));
    if (at.getTime() > Date.now() - 30 * 60_000) continue;
    const weekday = new Date(at.getTime() + VN_OFFSET_H * 3600_000).getUTCDay();
    // Thứ bảy, chủ nhật đông hơn ngày thường.
    if ((weekday === 0 || weekday === 6) && !r.chance(0.85)) continue;
    if (weekday !== 0 && weekday !== 6 && !r.chance(0.6)) continue;
    return at;
  }
}

const roundUp = (amount: number, step: number) =>
  Math.ceil(amount / step) * step;

const LAST_NAMES = [
  'Nguyễn',
  'Trần',
  'Lê',
  'Phạm',
  'Hoàng',
  'Vũ',
  'Đặng',
  'Bùi',
  'Đỗ',
  'Ngô',
  'Dương',
  'Lý',
  'Phan',
  'Trịnh',
  'Mai',
];
const MIDDLE_M = [
  'Văn',
  'Đức',
  'Minh',
  'Quang',
  'Hữu',
  'Thành',
  'Tuấn',
  'Ngọc',
];
const MIDDLE_F = ['Thị', 'Thu', 'Ngọc', 'Thanh', 'Phương', 'Hải', 'Minh'];
const FIRST_M = [
  'Anh',
  'Hùng',
  'Dũng',
  'Long',
  'Nam',
  'Khánh',
  'Sơn',
  'Tùng',
  'Phúc',
  'Huy',
  'Quân',
  'Đạt',
  'Trung',
  'Hiếu',
  'Thắng',
];
const FIRST_F = [
  'Hà',
  'Linh',
  'Trang',
  'Hương',
  'Lan',
  'Mai',
  'Ngọc',
  'Thảo',
  'Hằng',
  'Yến',
  'Vy',
  'Nhung',
  'Quỳnh',
];
const HN_STREETS = [
  'Trường Chinh, Đống Đa',
  'Láng Hạ, Đống Đa',
  'Xuân Thủy, Cầu Giấy',
  'Trần Duy Hưng, Cầu Giấy',
  'Nguyễn Trãi, Thanh Xuân',
  'Kim Mã, Ba Đình',
  'Minh Khai, Hai Bà Trưng',
  'Lạc Long Quân, Tây Hồ',
  'Hồ Tùng Mậu, Bắc Từ Liêm',
  'Nguyễn Văn Cừ, Long Biên',
  'Giải Phóng, Hoàng Mai',
  'Tố Hữu, Hà Đông',
];
const HCM_STREETS = [
  'Lạc Long Quân, Quận 11',
  'Cách Mạng Tháng 8, Quận 3',
  'Nguyễn Thị Minh Khai, Quận 1',
  'Phan Xích Long, Phú Nhuận',
  'Quang Trung, Gò Vấp',
  'Nguyễn Văn Linh, Quận 7',
  'Kinh Dương Vương, Bình Tân',
];
const MOBILE_PREFIX = [
  '090',
  '091',
  '093',
  '094',
  '096',
  '097',
  '098',
  '032',
  '033',
  '035',
  '036',
  '037',
  '038',
  '039',
  '070',
  '077',
  '079',
  '081',
  '083',
  '084',
  '085',
  '086',
  '088',
  '089',
];

function person(r: Rng, male = r.chance(0.5)) {
  return {
    lastName: `${r.pick(LAST_NAMES)} ${r.pick(male ? MIDDLE_M : MIDDLE_F)}`,
    firstName: r.pick(male ? FIRST_M : FIRST_F),
    gender: male ? 'MALE' : 'FEMALE',
  };
}

function phone(r: Rng) {
  return `${r.pick(MOBILE_PREFIX)}${String(r.int(0, 9_999_999)).padStart(7, '0')}`;
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

  async login(phoneNumber: string): Promise<string> {
    const data = await this.call<{ accessToken: string }>(
      null,
      'post',
      '/auth/login',
      {
        phoneNumber,
        password: PASSWORD,
      },
    );
    return data.accessToken;
  }
}

// ---------------------------------------------------------------- dời thời gian

interface TableInfo {
  ts: string[];
  dates: string[];
  cols: Set<string>;
}

class TimeShifter {
  private tables = new Map<string, TableInfo>();
  private static readonly TRIGGERS: [string, string][] = [
    ['sales_journal_entries', 'sales_journal_entries_no_update'],
    ['sales_journal_lines', 'sales_journal_lines_no_update'],
    ['order_events', 'order_events_no_update'],
    ['supplier_debt_entries', 'supplier_debt_entries_no_update'],
  ];

  constructor(private readonly prisma: PrismaService) {}

  async load() {
    const rows = await this.prisma.$queryRaw<
      { table_name: string; column_name: string; data_type: string }[]
    >`SELECT table_name, column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name NOT LIKE '\\_%'`;
    for (const row of rows) {
      const info = this.tables.get(row.table_name) ?? {
        ts: [],
        dates: [],
        cols: new Set<string>(),
      };
      info.cols.add(row.column_name);
      if (row.data_type.startsWith('timestamp')) info.ts.push(row.column_name);
      if (row.data_type === 'date') info.dates.push(row.column_name);
      this.tables.set(row.table_name, info);
    }
  }

  async setTriggers(enabled: boolean) {
    for (const [table, trigger] of TimeShifter.TRIGGERS) {
      await this.prisma.$executeRawUnsafe(
        `ALTER TABLE "${table}" ${enabled ? 'ENABLE' : 'DISABLE'} TRIGGER "${trigger}"`,
      );
    }
  }

  /** SET cho một bảng: mọi cột thời gian cộng `seconds`; ngày kinh doanh của sổ doanh thu tính lại từ giờ ghi mới. */
  private setClause(
    table: string,
    info: TableInfo,
    seconds: number,
  ): string | null {
    const shift = `make_interval(secs => ${seconds})`;
    const parts = info.ts.map((c) => `"${c}" = "${c}" + ${shift}`);
    for (const c of info.dates) {
      if (table === 'sales_journal_entries' && c === 'business_date') {
        parts.push(
          `"business_date" = (("posted_at" + ${shift}) AT TIME ZONE 'Asia/Ho_Chi_Minh')::date`,
        );
      } else {
        parts.push(`"${c}" = ("${c}" + ${shift})::date`);
      }
    }
    return parts.length ? parts.join(', ') : null;
  }

  private async update(table: string, where: string, seconds: number) {
    const info = this.tables.get(table);
    if (!info) return;
    const set = this.setClause(table, info, seconds);
    if (set)
      await this.prisma.$executeRawUnsafe(
        `UPDATE "${table}" SET ${set} WHERE ${where}`,
      );
  }

  /** Dời mọi dòng thuộc đơn (đơn, dòng hàng, thanh toán, thu chi, sổ doanh thu, sổ kho, giao hàng, hoàn hàng, hoá đơn, lịch sử) sao cho đơn được tạo lúc `target`. */
  async shiftOrder(orderId: string, target: Date) {
    const [order] = await this.prisma.$queryRaw<{ created_at: Date }[]>`
      SELECT created_at FROM orders WHERE id = ${orderId}`;
    const seconds = Math.round(
      (target.getTime() - order.created_at.getTime()) / 1000,
    );
    const q = (s: string) => `'${s}'`;
    const itemIds = (
      await this.prisma.orderItem.findMany({
        where: { orderId },
        select: { id: true },
      })
    ).map((i) => q(i.id));
    const shipmentIds = (
      await this.prisma.shipment.findMany({
        where: { orderId },
        select: { id: true },
      })
    ).map((s) => q(s.id));

    for (const [table, info] of this.tables) {
      if (table === 'orders') {
        await this.update(table, `id = ${q(orderId)}`, seconds);
      } else if (info.cols.has('order_id')) {
        await this.update(table, `order_id = ${q(orderId)}`, seconds);
      } else if (info.cols.has('order_item_id') && itemIds.length) {
        await this.update(
          table,
          `order_item_id IN (${itemIds.join(',')})`,
          seconds,
        );
      } else if (info.cols.has('shipment_id') && shipmentIds.length) {
        await this.update(
          table,
          `shipment_id IN (${shipmentIds.join(',')})`,
          seconds,
        );
      }
    }
  }

  /** Dời các dòng của đơn được ghi từ `since` trở đi (một bước làm sau, như trả hàng) tới `target`; dòng cũ hơn giữ nguyên. */
  async shiftOrderSince(orderId: string, since: Date, target: Date) {
    const seconds = Math.round((target.getTime() - Date.now()) / 1000);
    const shift = `make_interval(secs => ${seconds})`;
    const cut = `'${since.toISOString()}'::timestamptz`;
    const q = (v: string) => `'${v}'`;
    const itemIds = (
      await this.prisma.orderItem.findMany({
        where: { orderId },
        select: { id: true },
      })
    ).map((i) => q(i.id));
    for (const [table, info] of this.tables) {
      let where: string | null = null;
      if (table === 'orders') where = `id = ${q(orderId)}`;
      else if (info.cols.has('order_id')) where = `order_id = ${q(orderId)}`;
      else if (info.cols.has('order_item_id') && itemIds.length)
        where = `order_item_id IN (${itemIds.join(',')})`;
      if (!where || !info.ts.length) continue;
      const parts = info.ts.map(
        (c) =>
          `"${c}" = CASE WHEN "${c}" >= ${cut} THEN "${c}" + ${shift} ELSE "${c}" END`,
      );
      if (table === 'sales_journal_entries') {
        parts.push(
          `"business_date" = CASE WHEN "posted_at" >= ${cut} THEN (("posted_at" + ${shift}) AT TIME ZONE 'Asia/Ho_Chi_Minh')::date ELSE "business_date" END`,
        );
      }
      await this.prisma.$executeRawUnsafe(
        `UPDATE "${table}" SET ${parts.join(', ')} WHERE ${where}`,
      );
    }
  }

  /** Dời phần thiết lập của shop (nhập kho, chuyển kho, lô, sổ kho, công nợ NCC, hàng hóa, khách, nhân viên) về `days` ngày trước. */
  async shiftSetup(tenantId: string, days: number) {
    const seconds = -days * 86_400;
    for (const table of [
      'stock_movement_requests',
      'inventory_lots',
      'inventory_transactions',
      'supplier_debt_entries',
      'inventories',
      'products',
      'product_items',
      'customers',
      'users',
      'locations',
      'roles',
      'suppliers',
    ]) {
      await this.update(table, `tenant_id = '${tenantId}'`, seconds);
    }
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
    sellable?: boolean;
    damaged?: string;
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
  tokens: Record<string, string>;
  skuIds: Record<string, string>;
  prices: Record<string, number>;
  customers: { id: string; name: string; phone: string; address: string }[];
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
    password: PASSWORD,
    otpCode: 'DEV_BYPASS',
    firstName: def.owner.firstName,
    lastName: def.owner.lastName,
  });
  const ownerToken: string = reg.accessToken;
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
    if (loc.kind === 'warehouse' && loc.sellable === false)
      body.isSellable = false;
    if (loc.damaged) body.damagedLocationId = locations[loc.damaged];
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
  const tokens: Record<string, string> = { owner: ownerToken };
  for (const s of def.staff) {
    const locKind = def.locations.find((l) => l.key === s.location)!.kind;
    const user = await api.call(ownerToken, 'post', '/users', {
      phoneNumber: s.phone,
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
    tokens[s.key] = await api.login(s.phone);
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
  const prices: Record<string, number> = {};
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
    for (const item of created.items as {
      id: string;
      sku: string;
      retailPrice: number;
    }[]) {
      skuIds[item.sku] = item.id;
      prices[item.sku] = Number(item.retailPrice);
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
    prices[combo.sku] = combo.retailPrice;
  }

  return {
    tenantId,
    ownerId,
    ownerToken,
    locations,
    staffIds,
    tokens,
    skuIds,
    prices,
    customers: [],
    supplierIds,
  };
}

async function addCustomers(
  api: Api,
  shop: Shop,
  token: string,
  count: number,
  streets: string[],
  city: string,
  r: Rng,
) {
  const used = new Set<string>();
  while (shop.customers.length < count) {
    const p = person(r);
    const tel = phone(r);
    if (used.has(tel)) continue;
    used.add(tel);
    const address = `${r.int(1, 320)} ${r.pick(streets)}, ${city}`;
    const row = await api.call(token, 'post', '/customers', {
      name: `${p.lastName} ${p.firstName}`,
      phone: tel,
      gender: p.gender,
      address,
    });
    shop.customers.push({ id: row.id, name: row.name, phone: tel, address });
  }
}

/** Nhập hàng từ NCC vào một kho: phiếu IMPORT rồi nhận đủ (đi qua cùng luồng màn Nhập hàng). */
async function importGoods(
  api: Api,
  token: string,
  shop: Shop,
  supplier: string,
  locationKey: string,
  lines: { sku: string; quantity: number; importPrice: number }[],
) {
  const movement = await api.call(token, 'post', '/stock-movements', {
    movementType: 'IMPORT',
    fromSupplierId: shop.supplierIds[supplier],
    toLocationId: shop.locations[locationKey],
    details: lines.map((l) => ({
      productItemId: shop.skuIds[l.sku],
      quantity: l.quantity,
      importPrice: l.importPrice,
    })),
  });
  await api.call(token, 'patch', `/stock-movements/${movement.id}/receive`, {
    details: lines.map((l) => ({
      productItemId: shop.skuIds[l.sku],
      receivedQuantity: l.quantity,
    })),
  });
}

/** Chuyển hàng kho -> chi nhánh: kho lập phiếu, soạn, xuất; chi nhánh nhận. */
async function transfer(
  api: Api,
  shop: Shop,
  from: { key: string; token: string },
  to: { key: string; token: string },
  lines: { sku: string; quantity: number }[],
) {
  const movement = await api.call(from.token, 'post', '/stock-movements', {
    movementType: 'EXPORT',
    fromLocationId: shop.locations[from.key],
    toLocationId: shop.locations[to.key],
    details: lines.map((l) => ({
      productItemId: shop.skuIds[l.sku],
      quantity: l.quantity,
    })),
  });
  for (const step of ['open', 'close', 'ship']) {
    await api.call(
      from.token,
      'patch',
      `/stock-movements/${movement.id}/${step}`,
    );
  }
  await api.call(to.token, 'patch', `/stock-movements/${movement.id}/receive`, {
    details: lines.map((l) => ({
      productItemId: shop.skuIds[l.sku],
      receivedQuantity: l.quantity,
    })),
  });
}

async function setMinStock(
  api: Api,
  shop: Shop,
  token: string,
  locationKey: string,
  minStock: Record<string, number>,
) {
  const rows = await api.call<{ id: string; productItemId: string }[]>(
    token,
    'get',
    '/inventory',
    {
      locationId: shop.locations[locationKey],
      limit: 100,
    },
  );
  for (const row of rows) {
    const sku = Object.keys(shop.skuIds).find(
      (k) => shop.skuIds[k] === row.productItemId,
    );
    if (sku && minStock[sku] !== undefined) {
      await api.call(token, 'patch', `/inventory/${row.id}/min-stock`, {
        minStock: minStock[sku],
      });
    }
  }
}

// ---------------------------------------------------------------- đơn giao hàng (journey)

type JourneyOutcome =
  | 'COMPLETED'
  | 'RETURNED_PART'
  | 'CANCELLED'
  | 'CONFIRMED'
  | 'PACKED'
  | 'SHIPPING'
  | 'RECEIVED';

interface JourneyOrder {
  at: Date;
  branch: string;
  sale: string;
  source: string;
  packer: string;
  driver: string;
  accountant: string;
  returnsClerk: string;
  manager: string;
  fulfillment: 'HOME_DELIVERY' | 'STORE_PICKUP';
  customer: Shop['customers'][number];
  lines: { sku: string; quantity: number; discountPct?: number }[];
  shippingFee: number;
  deposit?: { pct: number; method: 'CASH' | 'BANK_TRANSFER' };
  outcome: JourneyOutcome;
  note?: string;
}

async function runJourney(
  api: Api,
  shop: Shop,
  shifter: TimeShifter,
  o: JourneyOrder,
): Promise<string> {
  const t = shop.tokens;
  const created = await api.call(t[o.sale], 'post', '/orders', {
    branchId: shop.locations[o.branch],
    customerId: o.customer.id,
    assigneeId: shop.staffIds[o.sale],
    fulfillmentType: o.fulfillment,
    priority: 'NORMAL',
    items: o.lines.map((l) => ({
      productItemId: shop.skuIds[l.sku],
      quantity: l.quantity,
      sourceLocationId: shop.locations[o.source],
      ...(l.discountPct
        ? {
            unitPrice:
              Math.round(
                (shop.prices[l.sku] * (100 - l.discountPct)) / 100 / 10_000,
              ) * 10_000,
          }
        : {}),
    })),
    shippingFee: o.shippingFee,
    ...(o.deposit
      ? {
          deposit: {
            type: 'PERCENT',
            value: o.deposit.pct,
            method: o.deposit.method,
          },
        }
      : {}),
    ...(o.fulfillment === 'HOME_DELIVERY'
      ? {
          recipientName: o.customer.name,
          recipientPhone: o.customer.phone,
          deliveryAddress: o.customer.address,
        }
      : {}),
    note: o.note,
  });
  const id: string = created.id;
  const detail = async () => api.call(t.owner, 'get', `/orders/${id}`);

  const finish = async () => {
    await shifter.shiftOrder(id, o.at);
    return id;
  };

  if (o.outcome === 'CANCELLED') {
    const current = await detail();
    // Tiền shop đang giữ = tổng đơn - còn phải thu (chưa hoàn lần nào).
    const held = Number(current.grandTotal) - Number(current.amountDue);
    await api.call(t[o.manager], 'post', `/orders/${id}/cancel`, {
      reason: 'Khách đổi ý, không lấy hàng nữa',
      ...(Number(held) > 0
        ? {
            refundAmount: Number(held),
            refundMethod: o.deposit?.method ?? 'CASH',
          }
        : {}),
    });
    return finish();
  }
  if (o.outcome === 'CONFIRMED') return finish();

  await api.call(t[o.packer], 'post', `/orders/${id}/pack`, {});
  if (o.outcome === 'PACKED') return finish();

  if (o.fulfillment === 'STORE_PICKUP') {
    const due = Number((await detail()).amountDue);
    // Khách tới kho xuất lấy hàng: thủ kho thu nốt tiền và giao (giao tại quầy là bước trừ tồn, cần orders:ship tại kho đó).
    if (due > 0)
      await api.call(t[o.packer], 'post', `/orders/${id}/pickup/collect`, {
        method: 'CASH',
      });
    await api.call(t[o.packer], 'post', `/orders/${id}/pickup/hand-over`, {
      receiverName: o.customer.name,
    });
  } else {
    const shipment = await api.call(t[o.packer], 'post', '/shipments', {
      orderId: id,
      carrierType: 'INTERNAL',
      driverId: shop.staffIds[o.driver],
    });
    await api.call(
      t[o.driver],
      'post',
      `/shipments/${shipment.id}/pick-up`,
      {},
    );
    await api.call(t[o.packer], 'post', `/orders/${id}/ship`, {});
    if (o.outcome === 'SHIPPING') return finish();
    const due = Number((await detail()).amountDue);
    await api.call(t[o.driver], 'post', `/shipments/${shipment.id}/deliver`, {
      proofPhotoUrls: ['https://example.com/demo/giao-hang.jpg'],
      paymentMethod: due > 0 ? 'CASH' : 'NONE',
      collectedAmount: due,
    });
    if (o.outcome === 'RECEIVED' && due > 0) return finish();
    if (due > 0) {
      await api.call(
        t[o.accountant],
        'post',
        `/orders/${id}/confirm-remittance`,
        { amount: due },
      );
    }
  }

  if (o.outcome === 'RETURNED_PART') {
    await shifter.shiftOrder(id, o.at);
    const since = new Date();
    const order = await detail();
    const line = order.items.find(
      (i: { parentItemId?: string | null; lineType?: string }) =>
        !i.parentItemId && i.lineType !== 'COMBO',
    );
    const ret = await api.call(t[o.returnsClerk], 'post', '/order-returns', {
      orderId: id,
      reason: 'CUSTOMER_RETURN',
      note: 'Khách đổi ý trong 7 ngày, hàng còn nguyên',
      items: [{ orderItemId: line.id, quantity: 1 }],
    });
    await api.call(
      t[o.returnsClerk],
      'post',
      `/order-returns/${ret.id}/receive`,
      {},
    );
    const reading = await api.call(
      t[o.returnsClerk],
      'get',
      `/order-returns/${ret.id}`,
    );
    await api.call(
      t[o.returnsClerk],
      'post',
      `/order-returns/${ret.id}/inspect`,
      {
        items: [{ orderItemId: line.id, condition: 'GOOD' }],
        refund: {
          amount: reading.refundSuggestion?.suggested ?? 0,
          method: 'BANK_TRANSFER',
          note: 'Hoàn tiền hàng trả',
        },
      },
    );
    // Khách mang trả sau 3 ngày.
    await shifter.shiftOrderSince(
      id,
      since,
      new Date(o.at.getTime() + 3 * 86_400_000),
    );
    return id;
  }
  return finish();
}

// ---------------------------------------------------------------- Nội thất IGM

const IGM: ShopDef = {
  tenantName: 'Nội thất IGM',
  owner: { phone: '0912000001', lastName: 'Phạm Quốc', firstName: 'Huy' },
  mainAddress: '248 Phố Vọng, Phương Liệt, Thanh Xuân, Hà Nội',
  taxNumber: '0109123456',
  locations: [
    {
      key: 'DAMAGED',
      kind: 'warehouse',
      name: 'Kho hàng lỗi',
      address: 'Ngõ 99 Định Công, Hoàng Mai, Hà Nội',
      phone: '0912000090',
      sellable: false,
    },
    {
      key: 'WH_HN',
      kind: 'warehouse',
      name: 'Kho tổng Hà Nội',
      address: 'KCN Thạch Thất - Quốc Oai, Hà Nội',
      phone: '0912000091',
      damaged: 'DAMAGED',
    },
    {
      key: 'WH_HCM',
      kind: 'warehouse',
      name: 'Kho Hồ Chí Minh',
      address: '120 Kinh Dương Vương, Bình Tân, TP. Hồ Chí Minh',
      phone: '0912000092',
      damaged: 'DAMAGED',
    },
    {
      key: 'TX',
      kind: 'branch',
      name: 'Showroom Thanh Xuân',
      address: '248 Phố Vọng, Phương Liệt, Thanh Xuân, Hà Nội',
      phone: '0912000093',
      damaged: 'DAMAGED',
    },
    {
      key: 'CG',
      kind: 'branch',
      name: 'Showroom Cầu Giấy',
      address: '16B20 ngõ 1 Nghĩa Tân, Cầu Giấy, Hà Nội',
      phone: '0912000094',
      damaged: 'DAMAGED',
    },
    {
      key: 'Q11',
      kind: 'branch',
      name: 'Showroom Quận 11',
      address: '3B hẻm 152/54 Lạc Long Quân, Quận 11, TP. Hồ Chí Minh',
      phone: '0912000095',
      damaged: 'DAMAGED',
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

async function seedIgm(
  api: Api,
  prisma: PrismaService,
  shifter: TimeShifter,
  adminToken: string,
) {
  const r = rng(20261115);
  const shop = await setupShop(api, IGM, adminToken, r);
  const t = shop.tokens;
  await addCustomers(api, shop, t.saleTX1, 30, HN_STREETS, 'Hà Nội', r);
  const hnCustomers = [...shop.customers];
  shop.customers = [];
  await addCustomers(
    api,
    shop,
    t.saleQ11,
    12,
    HCM_STREETS,
    'TP. Hồ Chí Minh',
    r,
  );
  const hcmCustomers = [...shop.customers];
  shop.customers = [...hnCustomers, ...hcmCustomers];

  // Tồn đầu: nhập từ NCC vào hai kho.
  const stockPlan = (big: boolean) =>
    IGM_PRODUCTS.flatMap((p) =>
      p.variants.map((variant) => ({
        sku: variant.sku,
        quantity: big ? r.int(18, 28) : r.int(6, 10),
        importPrice: variant.costPrice,
        supplier: p.supplier,
      })),
    );
  for (const [wh, token, big] of [
    ['WH_HN', t.whHN, true],
    ['WH_HCM', t.whHCM, false],
  ] as const) {
    const plan = stockPlan(big);
    for (const supplier of new Set(plan.map((l) => l.supplier))) {
      await importGoods(
        api,
        token,
        shop,
        supplier,
        wh,
        plan.filter((l) => l.supplier === supplier),
      );
    }
  }
  // Hai SKU để thấp hơn mức tối thiểu để có cảnh báo tồn kho.
  await setMinStock(api, shop, t.whHN, 'WH_HN', {
    'SH005-1': 25,
    'TVP11011-12215': 26,
    'MHT11011-120': 8,
  });
  await shifter.shiftSetup(shop.tenantId, 75);

  const skuPool: [string, number][] = [
    ['MHT11011-120', 9],
    ['MHT11011-140', 5],
    ['MHT11011-160', 4],
    ['LHT013-3', 4],
    ['HTH11011', 3],
    ['IGM90055-XAM', 8],
    ['IGM90055-DEN', 6],
    ['SH005-1', 3],
    ['KMH005-TRANG', 4],
    ['KMH005-WALNUT', 3],
    ['TVP11011-1218', 3],
    ['TVP11011-12215', 2],
    ['BILLY-6T', 4],
    ['HT001-1', 5],
    ['KMH004-DEN', 6],
    ['KMH004-TRANG', 3],
    ['COMBO-MHT-IGM900', 5],
  ];
  const regions = {
    HN: {
      branches: [
        ['TX', ['saleTX1', 'saleTX2'], 'mgrTX'],
        ['CG', ['saleCG'], 'saleCG'],
      ] as [string, string[], string][],
      source: 'WH_HN',
      packer: 'whHN',
      drivers: ['drvHN1', 'drvHN2'],
      customers: hnCustomers,
    },
    HCM: {
      branches: [['Q11', ['saleQ11'], 'mgrQ11']] as [
        string,
        string[],
        string,
      ][],
      source: 'WH_HCM',
      packer: 'whHCM',
      drivers: ['drvHCM'],
      customers: hcmCustomers,
    },
  };

  const plans: JourneyOrder[] = [];
  const outcomes: [JourneyOutcome, number][] = [
    ['COMPLETED', 30],
    ['RETURNED_PART', 2],
    ['CANCELLED', 4],
  ];
  const build = (outcome: JourneyOutcome, at: Date): JourneyOrder => {
    const region = r.chance(0.75) ? regions.HN : regions.HCM;
    const [branch, sales, manager] = r.pick(region.branches);
    const lineCount = r.weighted<number>([
      [1, 6],
      [2, 3],
      [3, 1],
    ]);
    const skus = new Set<string>();
    while (skus.size < lineCount) skus.add(r.weighted(skuPool));
    const pickup =
      outcome !== 'RECEIVED' && outcome !== 'SHIPPING' && r.chance(0.15);
    const depositRoll = r.next();
    return {
      at,
      branch,
      sale: r.pick(sales),
      source: region.source,
      packer: region.packer,
      driver: r.pick(region.drivers),
      accountant: 'acc',
      returnsClerk: 'cs',
      manager,
      fulfillment: pickup ? 'STORE_PICKUP' : 'HOME_DELIVERY',
      customer: r.pick(region.customers),
      lines: [...skus].map((sku) => ({
        sku,
        quantity:
          sku.startsWith('IGM900') || sku.startsWith('KMH')
            ? r.weighted<number>([
                [1, 6],
                [2, 3],
                [4, 1],
              ])
            : 1,
        discountPct: r.chance(0.25) ? r.pick([3, 5, 8]) : undefined,
      })),
      shippingFee: pickup
        ? 0
        : r.weighted<number>([
            [0, 6],
            [150_000, 2],
            [300_000, 1],
          ]),
      deposit:
        depositRoll < 0.45
          ? {
              pct: r.pick([20, 30, 50]),
              method: r.chance(0.6) ? 'BANK_TRANSFER' : 'CASH',
            }
          : depositRoll < 0.6
            ? { pct: 100, method: 'BANK_TRANSFER' }
            : undefined,
      outcome,
      note: r.chance(0.3)
        ? r.pick([
            'Giao giờ hành chính',
            'Gọi trước khi giao 30 phút',
            'Lắp đặt tại tầng 5, có thang máy',
            'Khách cần xuất hoá đơn công ty',
          ])
        : undefined,
    };
  };
  for (const [outcome, count] of outcomes) {
    for (let i = 0; i < count; i++)
      plans.push(build(outcome, salesMoment(r, 3, DAYS)));
  }
  // Hôm nay vài đơn đã hoàn tất (nếu đã qua giờ mở cửa), còn lại là việc đang dở của 1-2 ngày gần đây.
  const vnHour = new Date(Date.now() + VN_OFFSET_H * 3600_000).getUTCHours();
  if (vnHour >= 11) {
    for (let i = 0; i < 2; i++)
      plans.push(
        build('COMPLETED', vnTime(0, r.int(9, vnHour - 1), r.int(0, 59))),
      );
  }
  for (const outcome of [
    'CONFIRMED',
    'CONFIRMED',
    'PACKED',
    'PACKED',
    'SHIPPING',
    'RECEIVED',
    'RECEIVED',
  ] as JourneyOutcome[]) {
    plans.push(build(outcome, salesMoment(r, 1, 2)));
  }
  plans.sort((a, b) => a.at.getTime() - b.at.getTime());

  let done = 0;
  for (const plan of plans) {
    await runJourney(api, shop, shifter, plan);
    done++;
  }
  console.log(`IGM: ${done} đơn.`);
  return shop;
}

// ---------------------------------------------------------------- 360 Boutique

const B360: ShopDef = {
  tenantName: '360 Boutique',
  owner: { phone: '0936000001', lastName: 'Lương Hoàng', firstName: 'Anh' },
  mainAddress: '82 Thái Hà, Đống Đa, Hà Nội',
  taxNumber: '0106789123',
  locations: [
    {
      key: 'DAMAGED',
      kind: 'warehouse',
      name: 'Kho hàng lỗi',
      address: '15 ngõ 36 Định Công, Hoàng Mai, Hà Nội',
      phone: '0936000090',
      sellable: false,
    },
    {
      key: 'WH',
      kind: 'warehouse',
      name: 'Kho tổng 360',
      address: '27 Phan Trọng Tuệ, Thanh Trì, Hà Nội',
      phone: '0936000091',
      damaged: 'DAMAGED',
    },
    {
      key: 'TH',
      kind: 'branch',
      name: '360 Thái Hà',
      address: '82 Thái Hà, Đống Đa, Hà Nội',
      phone: '0936000092',
      damaged: 'DAMAGED',
    },
    {
      key: 'DCV',
      kind: 'branch',
      name: '360 Đại Cồ Việt',
      address: '45 Đại Cồ Việt, Hai Bà Trưng, Hà Nội',
      phone: '0936000093',
      damaged: 'DAMAGED',
    },
    {
      key: 'CG',
      kind: 'branch',
      name: '360 Cầu Giấy',
      address: '168 Cầu Giấy, Cầu Giấy, Hà Nội',
      phone: '0936000094',
      damaged: 'DAMAGED',
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

async function seedB360(
  api: Api,
  prisma: PrismaService,
  shifter: TimeShifter,
  adminToken: string,
) {
  const r = rng(360360);
  const shop = await setupShop(api, B360, adminToken, r);
  const t = shop.tokens;
  await addCustomers(api, shop, t.cashTH1, 45, HN_STREETS, 'Hà Nội', r);

  const allSkus = B360_PRODUCTS.flatMap((p) =>
    p.variants.map((variant) => ({ ...variant, supplier: p.supplier })),
  );
  for (const supplier of new Set(allSkus.map((s) => s.supplier))) {
    await importGoods(
      api,
      t.wh,
      shop,
      supplier,
      'WH',
      allSkus
        .filter((s) => s.supplier === supplier)
        .map((s) => ({
          sku: s.sku,
          quantity: r.int(30, 45),
          importPrice: s.costPrice,
        })),
    );
  }
  const branches: [string, string, string[]][] = [
    ['TH', 'mgrTH', ['cashTH1', 'cashTH2']],
    ['DCV', 'mgrDCV', ['cashDCV1', 'cashDCV2']],
    ['CG', 'mgrCG', ['cashCG1', 'cashCG2']],
  ];
  const branchStock: Record<string, Record<string, number>> = {};
  for (const [branch, manager] of branches) {
    const lines = allSkus.map((s) => ({ sku: s.sku, quantity: r.int(5, 8) }));
    await transfer(
      api,
      shop,
      { key: 'WH', token: t.wh },
      { key: branch, token: t[manager] },
      lines,
    );
    branchStock[branch] = Object.fromEntries(
      lines.map((l) => [l.sku, l.quantity]),
    );
  }
  await setMinStock(
    api,
    shop,
    t.owner,
    'TH',
    Object.fromEntries(
      allSkus.filter((s) => s.sku.includes('ADLTK204')).map((s) => [s.sku, 7]),
    ),
  );
  await shifter.shiftSetup(shop.tenantId, 75);

  // Bán chạy: polo, áo thun, quần âu; áo khoác bán ít hơn.
  const popularity = (sku: string) =>
    sku.startsWith('POHTK') || sku.startsWith('APHTK')
      ? 5
      : sku.startsWith('ADLTK') || sku.startsWith('AHHTK')
        ? 1.5
        : sku.startsWith('CAPCN') || sku.startsWith('DEPCN')
          ? 1
          : 3;
  const pool: [string, number][] = allSkus.map((s) => [
    s.sku,
    popularity(s.sku),
  ]);

  let pos = 0;
  let posReturns = 0;
  const sales: { id: string; branch: string; at: Date }[] = [];
  const posPlans = Array.from({ length: 150 }, () => ({
    at: salesMoment(r, 0, DAYS),
    branch: r.weighted<[string, string, string[]]>([
      [branches[0], 5],
      [branches[1], 3],
      [branches[2], 4],
    ]),
  }));
  posPlans.sort((a, b) => a.at.getTime() - b.at.getTime());
  for (const { at, branch } of posPlans) {
    const [key, , cashiers] = branch;
    const stock = branchStock[key];
    const count = r.weighted<number>([
      [1, 5],
      [2, 4],
      [3, 2],
      [4, 1],
    ]);
    const lines = new Map<string, number>();
    for (let tries = 0; lines.size < count && tries < 20; tries++) {
      const sku = r.weighted(pool);
      if ((stock[sku] ?? 0) - (lines.get(sku) ?? 0) <= 0) continue;
      lines.set(sku, (lines.get(sku) ?? 0) + 1);
    }
    if (!lines.size) continue;
    const total = [...lines].reduce(
      (n, [sku, q]) => n + shop.prices[sku] * q,
      0,
    );
    const method = r.weighted<string>([
      ['CASH', 50],
      ['BANK_TRANSFER', 38],
      ['MOMO', 12],
    ]);
    const member = r.chance(0.45) ? r.pick(shop.customers) : undefined;
    const sale = await api.call(t[r.pick(cashiers)], 'post', '/orders/pos', {
      branchId: shop.locations[key],
      ...(member ? { customerId: member.id } : {}),
      paymentMethod: method,
      items: [...lines].map(([sku, quantity]) => ({
        productItemId: shop.skuIds[sku],
        quantity,
      })),
      ...(method === 'CASH'
        ? { customerPay: roundUp(total, r.pick([10_000, 50_000, 100_000])) }
        : {}),
    });
    // Bán ở quầy trả `{ order, ... }`.
    const saleId: string = sale.order?.id ?? sale.id;
    for (const [sku, q] of lines) stock[sku] -= q;
    await shifter.shiftOrder(saleId, at);
    sales.push({ id: saleId, branch: key, at });
    pos++;
  }
  // Vài khách trả lại hàng mua ở quầy (đổi ý, sai size) trong vài ngày sau.
  for (const sale of sales.filter(
    (s) => s.at.getTime() < Date.now() - 5 * 86_400_000,
  )) {
    if (posReturns >= 6 || !r.chance(0.06)) continue;
    const manager = branches.find(([k]) => k === sale.branch)![1];
    const since = new Date();
    await api.call(t[manager], 'patch', `/orders/${sale.id}/status`, {
      status: 'RETURNED',
    });
    await shifter.shiftOrderSince(
      sale.id,
      since,
      new Date(sale.at.getTime() + r.int(2, 6) * 86_400_000),
    );
    posReturns++;
  }

  // Đơn online: chốt qua fanpage, xuất từ kho tổng, shipper của shop giao, thu COD.
  const onlinePlans: JourneyOrder[] = [];
  const build = (outcome: JourneyOutcome, at: Date): JourneyOrder => {
    const skus = new Set<string>();
    const count = r.weighted<number>([
      [1, 4],
      [2, 4],
      [3, 2],
    ]);
    while (skus.size < count) skus.add(r.weighted(pool));
    return {
      at,
      branch: 'TH',
      sale: 'online',
      source: 'WH',
      packer: 'wh',
      driver: 'drv',
      accountant: 'acc',
      returnsClerk: 'online',
      manager: 'mgrTH',
      fulfillment: 'HOME_DELIVERY',
      customer: r.pick(shop.customers),
      lines: [...skus].map((sku) => ({ sku, quantity: 1 })),
      shippingFee: r.pick([0, 25_000, 30_000]),
      deposit: r.chance(0.3)
        ? { pct: 100, method: 'BANK_TRANSFER' }
        : undefined,
      outcome,
      note: r.chance(0.4)
        ? r.pick([
            'Khách đặt qua fanpage',
            'Khách đặt qua Zalo',
            'Giao sau 18h',
          ])
        : undefined,
    };
  };
  for (let i = 0; i < 12; i++)
    onlinePlans.push(build('COMPLETED', salesMoment(r, 3, DAYS)));
  onlinePlans.push(build('CANCELLED', salesMoment(r, 3, DAYS)));
  for (const outcome of [
    'CONFIRMED',
    'PACKED',
    'SHIPPING',
    'RECEIVED',
  ] as JourneyOutcome[]) {
    onlinePlans.push(build(outcome, salesMoment(r, 1, 2)));
  }
  onlinePlans.sort((a, b) => a.at.getTime() - b.at.getTime());
  for (const plan of onlinePlans) await runJourney(api, shop, shifter, plan);
  console.log(
    `360 Boutique: ${pos} đơn quầy (${posReturns} trả hàng), ${onlinePlans.length} đơn online.`,
  );
  return shop;
}

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

  it('creates Nội thất IGM and 360 Boutique with staff, stock and 60 days of sales', async () => {
    for (const phoneNumber of [IGM.owner.phone, B360.owner.phone]) {
      if (await prisma.user.findFirst({ where: { phoneNumber } })) {
        throw new Error(
          `${phoneNumber} đã có trong DB: seed mẫu đã chạy rồi. Reset DB trước khi chạy lại.`,
        );
      }
    }
    const api = new Api(app);
    const adminToken = await api.login(ADMIN_PHONE);
    const shifter = new TimeShifter(prisma);
    await shifter.load();
    await shifter.setTriggers(false);
    try {
      await seedIgm(api, prisma, shifter, adminToken);
      await seedB360(api, prisma, shifter, adminToken);
    } finally {
      await shifter.setTriggers(true);
    }
  });
});
