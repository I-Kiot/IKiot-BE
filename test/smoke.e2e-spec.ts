import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import * as bcrypt from 'bcryptjs';
import type { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AllExceptionsFilter } from './../src/common/filters/all-exceptions.filter';
import { PrismaService } from './../src/prisma/prisma.service';
import { InventoryService } from './../src/modules/inventories/inventories.service';
import { STAFF_BASE_PERMISSIONS } from './../src/common/constants/system-role';
import {
  InventoryRefType,
  InventoryTxType,
  LotSourceType,
} from './../src/common/constants/inventory-ledger';

/**
 * Smoke test một lần cho mọi thứ port ngày 2026-08-25 (sản phẩm, tồn kho, nhân viên, phiếu chuyển kho) trên Postgres thật. Tạo một tenant, chạy các route, rồi xoá mọi thứ đã tạo.
 */
jest.setTimeout(120_000);

const PHONE_OWNER = '0987650001';
const PHONE_STAFF = '0987650002';
// Admin nền tảng dùng một lần (tenantId null), cho các route chỉ operator mới vào được.
const PHONE_ADMIN = '0987650009';
const TENANT_NAME = 'SmokeTest Shop 25-08';

describe('smoke: products / inventory / staff / stock movements', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let http: () => request.Agent;

  let ownerToken = '';
  let tenantId = '';
  let branchId = '';
  let warehouseId = '';
  let productId = '';
  let itemAId = '';
  let itemBId = '';
  let supplierId = '';
  let roleId = '';
  let staffId = '';
  let orderId = '';
  let promotionId = '';
  let sessionId = '';
  let secondStaffId = '';
  let adminId = '';
  let shiftTemplateId = '';
  let scheduleId = '';

  const auth = (token = ownerToken) => ({ Authorization: `Bearer ${token}` });
  /** Thêm tồn theo cách duy nhất còn được phép - dưới dạng lô (sổ giá vốn theo lô, 2026-10-01). Ghi thẳng `inventories.stock` sẽ phá "các lô cộng lại bằng tồn" và lần bán sau không lấy được hàng. */
  const topUp = (locationId: string, productItemId: string, quantity: number) =>
    prisma.$transaction((tx) =>
      app.get(InventoryService).openLot(tx, {
        tenantId,
        locationId,
        productItemId,
        quantity,
        unitCost: 120000,
        sourceType: LotSourceType.SUPPLIER,
        ledger: {
          type: InventoryTxType.IMPORT,
          referenceType: InventoryRefType.STOCK_MOVEMENT,
          referenceId: 'smoke-top-up',
        },
      }),
    );
  const results: string[] = [];
  const note = (line: string) => results.push(line);

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
    http = () => request(app.getHttpServer());

    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await app?.close();

    console.log('\n===== SMOKE RESULTS =====\n' + results.join('\n'));
  });

  async function cleanup() {
    const tenant = await prisma.tenant.findFirst({
      where: { name: TENANT_NAME },
      select: { id: true },
    });
    if (!tenant) return;
    const t = tenant.id;
    await prisma.cashDrawerShiftLog.deleteMany({
      where: { session: { tenantId: t } },
    });
    await prisma.cashDrawerSession.deleteMany({ where: { tenantId: t } });
    await prisma.promotionLog.deleteMany({ where: { tenantId: t } });
    await prisma.orderAppliedPromotion.deleteMany({
      where: { order: { tenantId: t } },
    });
    await prisma.payment.deleteMany({
      where: { tenantId: t, refundOfPaymentId: { not: null } },
    });
    await prisma.payment.deleteMany({ where: { tenantId: t } });
    await prisma.invoice.deleteMany({ where: { tenantId: t } });
    await prisma.orderItem.deleteMany({ where: { order: { tenantId: t } } });
    await prisma.cashFlow.deleteMany({ where: { tenantId: t } });
    await prisma.order.deleteMany({ where: { tenantId: t } });
    await prisma.customer.deleteMany({ where: { tenantId: t } });
    await prisma.promotionBranch.deleteMany({
      where: { promotion: { tenantId: t } },
    });
    await prisma.promotionCategory.deleteMany({
      where: { promotion: { tenantId: t } },
    });
    await prisma.promotionProductItem.deleteMany({
      where: { promotion: { tenantId: t } },
    });
    await prisma.promotion.deleteMany({ where: { tenantId: t } });
    await prisma.stockMovementRequestItem.deleteMany({
      where: { request: { tenantId: t } },
    });
    await prisma.stockMovementRequest.deleteMany({ where: { tenantId: t } });
    await prisma.inventoryTransaction.deleteMany({ where: { tenantId: t } });
    await prisma.inventoryLot.deleteMany({ where: { tenantId: t } });
    await prisma.inventory.deleteMany({ where: { tenantId: t } });
    await prisma.productItemSupplier.deleteMany({
      where: { productItem: { tenantId: t } },
    });
    await prisma.productItemImage.deleteMany({
      where: { productItem: { tenantId: t } },
    });
    await prisma.productItemDetail.deleteMany({
      where: { productItem: { tenantId: t } },
    });
    await prisma.productItem.deleteMany({ where: { tenantId: t } });
    await prisma.productImage.deleteMany({
      where: { product: { tenantId: t } },
    });
    await prisma.product.deleteMany({ where: { tenantId: t } });
    await prisma.supplier.deleteMany({ where: { tenantId: t } });
    await prisma.holiday.deleteMany({ where: { tenantId: t } });
    await prisma.workingScheduleUser.deleteMany({
      where: { schedule: { tenantId: t } },
    });
    await prisma.workingSchedule.deleteMany({ where: { tenantId: t } });
    await prisma.shiftTemplate.deleteMany({ where: { tenantId: t } });
    await prisma.ticketMessage.deleteMany({
      where: { ticket: { tenantId: t } },
    });
    await prisma.ticket.deleteMany({ where: { tenantId: t } });
    await prisma.aIChatHistory.deleteMany({ where: { tenantId: t } });
    await prisma.notification.deleteMany({ where: { tenantId: t } });
    // Thông báo chung có tenantId null nhưng tới tenant này qua bảng nối, và các dòng đó giữ FK tới tenant - nên phải xóa trước tenant. Xóa sẽ cascade sang NotificationTargetTenant.
    await prisma.notification.deleteMany({
      where: { type: 'ANNOUNCEMENT', targetTenants: { some: { tenantId: t } } },
    });
    await prisma.auditLog.deleteMany({ where: { tenantId: t } });
    await prisma.subscriptionHistoryLog.deleteMany({
      where: { subscription: { tenantId: t } },
    });
    await prisma.subscriptionInvoice.deleteMany({ where: { tenantId: t } });
    await prisma.subscription.deleteMany({ where: { tenantId: t } });
    await prisma.location.updateMany({
      where: { tenantId: t },
      data: { managerId: null },
    });
    await prisma.rolePermission.deleteMany({
      where: { role: { tenantId: t } },
    });
    await prisma.userFcmToken.deleteMany({ where: { user: { tenantId: t } } });
    await prisma.user.updateMany({
      where: { tenantId: t },
      data: { roleId: null, locationId: null },
    });
    await prisma.role.deleteMany({ where: { tenantId: t } });
    await prisma.user.deleteMany({ where: { tenantId: t } });
    // Dòng Branch/Warehouse cascade từ Location của chúng.
    await prisma.location.deleteMany({ where: { tenantId: t } });
    await prisma.tenant.deleteMany({ where: { id: t } });
    // Nằm ngoài tenant (tenantId null) nên lệnh xóa ở trên không chạm tới.
    await prisma.notification.deleteMany({
      where: {
        tenantId: null,
        type: {
          in: [
            'SYSTEM_TENANT_BANK_UPDATED',
            'SYSTEM_TICKET_CREATED',
            'ANNOUNCEMENT',
          ],
        },
      },
    });
    await prisma.auditLog.deleteMany({
      where: { userId: adminId || undefined },
    });
    await prisma.user.deleteMany({ where: { phoneNumber: PHONE_ADMIN } });
  }

  it('sets up a tenant on a trial with a branch, a warehouse and a supplier', async () => {
    const registered = await http()
      .post('/auth/register')
      .send({
        tenantName: TENANT_NAME,
        phoneNumber: PHONE_OWNER,
        password: 'password123',
        otpCode: 'DEV_BYPASS',
      })
      .expect(201);
    ownerToken = registered.body.data.accessToken;
    tenantId = registered.body.data.user.tenantId;
    note(`register: OK tenant=${tenantId.slice(0, 8)}`);

    await http()
      .post('/subscription/free-trial')
      .set(auth())
      .send()
      .expect(201);
    const status = await http()
      .get('/subscription/status')
      .set(auth())
      .expect(200);
    note(
      `subscription: ${status.body.data.status} daysLeft=${status.body.data.daysLeft}`,
    );

    const branch = await http()
      .post('/branches')
      .set(auth())
      .send({ name: 'CN Q1', phoneNumber: ['0987650010'] })
      .expect(201);
    branchId = branch.body.data.id;

    const warehouse = await http()
      .post('/warehouses')
      .set(auth())
      .send({ name: 'Kho Trung Tam', phoneNumber: ['0987650011'] })
      .expect(201);
    warehouseId = warehouse.body.data.id;
    // Kho cũng tạo được đơn, nên có dòng `branches` cùng id, nhưng không lẫn vào danh sách chi nhánh.
    expect(await prisma.branch.count({ where: { id: warehouseId } })).toBe(1);
    const listedBranches = await http()
      .get('/branches')
      .set(auth())
      .expect(200);
    expect(
      listedBranches.body.data.map((row: { id: string }) => row.id),
    ).not.toContain(warehouseId);
    note('branch + warehouse: OK');

    const supplier = await http()
      .post('/suppliers')
      .set(auth())
      .send({ supplierName: 'NCC Alpha', creditLimit: 10_000_000 })
      .expect(201);
    supplierId = supplier.body.data.id;
    note(`supplier: OK creditLimit=${supplier.body.data.creditLimit}`);
  });

  // Từ sổ giá vốn theo lô (2026-10-01), sản phẩm được tạo với tồn 0: tồn chỉ vào qua lô (nhập, xưởng giao, hoàn). Tồn đầu mà suite cần được mở ở đây giống một lần nhập, đi thẳng qua InventoryService.
  it('creates a product with variants, then opens its stock in lots', async () => {
    const created = await http()
      .post('/products')
      .set(auth())
      .send({
        name: 'Áo thun',
        items: [
          {
            productName: 'Áo thun đỏ',
            productCode: 'AT-RED',
            sku: 'SKU-RED',
            retailPrice: 200000,
            costPrice: 120000,
            productDetails: [{ name: 'Màu', value: 'Đỏ' }],
          },
          {
            productName: 'Áo thun xanh',
            productCode: 'AT-BLUE',
            sku: 'SKU-BLUE',
            retailPrice: 210000,
            costPrice: 130000,
          },
        ],
      })
      .expect(201);

    productId = created.body.data.id;
    itemAId = created.body.data.items.find((i: any) => i.sku === 'SKU-RED').id;
    itemBId = created.body.data.items.find((i: any) => i.sku === 'SKU-BLUE').id;

    expect(created.body.data.totalStock).toBe(0);
    const inventory = app.get(InventoryService);
    for (const [locationId, quantity] of [
      [warehouseId, 50],
      [branchId, 8],
    ] as const) {
      await prisma.$transaction((tx) =>
        inventory.openLot(tx, {
          tenantId,
          locationId,
          productItemId: itemAId,
          quantity,
          unitCost: 120000,
          sourceType: LotSourceType.SUPPLIER,
          ledger: {
            type: InventoryTxType.IMPORT,
            referenceType: InventoryRefType.STOCK_MOVEMENT,
            referenceId: 'smoke-opening',
          },
        }),
      );
    }
    expect(typeof created.body.data.items[0].retailPrice).toBe('number');
    note(
      `POST /products: OK totalStock=${created.body.data.totalStock} items=${created.body.data.items.length} price is number=${typeof created.body.data.items[0].retailPrice === 'number'}`,
    );

    await http()
      .post('/products')
      .set(auth())
      .send({
        name: 'Trùng SKU',
        items: [
          {
            productName: 'x',
            productCode: 'x',
            sku: 'SKU-RED',
            retailPrice: 1,
            costPrice: 1,
          },
        ],
      })
      .expect(409);
    note('POST /products duplicate SKU: 409 OK');

    const rolled = await prisma.product.count({
      where: { tenantId, name: 'Trùng SKU' },
    });
    expect(rolled).toBe(0);
    note('duplicate SKU left no half-created product: OK');

    // Mã hàng và mã vạch duy nhất trong cửa hàng như SKU (2026-11-06); mã vạch trống được lặp lại.
    await prisma.productItem.update({
      where: { id: itemAId },
      data: { barcode: '8930000000017' },
    });
    const clash = (item: Record<string, unknown>) =>
      http()
        .post('/products')
        .set(auth())
        .send({
          name: 'Trùng mã',
          items: [{ productName: 'y', retailPrice: 1, costPrice: 1, ...item }],
        });
    const codeTaken = await clash({ productCode: 'AT-RED' }).expect(409);
    expect(codeTaken.body.code).toBe('PRODUCT_CODE_TAKEN');
    const barcodeTaken = await clash({ barcode: ' 8930000000017 ' }).expect(
      409,
    );
    expect(barcodeTaken.body.code).toBe('BARCODE_TAKEN');
    const sameBarcode = await http()
      .post('/products')
      .set(auth())
      .send({
        name: 'Trùng mã',
        items: [
          { productName: 'y1', barcode: '893X', retailPrice: 1, costPrice: 1 },
          { productName: 'y2', barcode: '893X', retailPrice: 1, costPrice: 1 },
        ],
      })
      .expect(400);
    expect(sameBarcode.body.code).toBe('BARCODE_DUPLICATE_IN_REQUEST');
    // Mã vạch để trống ghi null, nên sửa mặt hàng B với '' không đụng ràng buộc unique.
    await http()
      .patch(`/products/items/${itemBId}`)
      .set(auth())
      .send({ barcode: '' })
      .expect(200);
    const b = await prisma.productItem.findUniqueOrThrow({
      where: { id: itemBId },
    });
    expect(b.barcode).toBeNull();
    note(
      'duplicate product code / barcode refused, blank barcode stored as null: OK',
    );
  });

  it('lists, searches and reads back products', async () => {
    const list = await http().get('/products').set(auth()).expect(200);
    expect(list.body.data[0].totalStock).toBe(58);
    note(
      `GET /products: OK total=${list.body.pagination.total} totalStock=${list.body.data[0].totalStock}`,
    );

    const scoped = await http()
      .get(`/products?locationId=${branchId}`)
      .set(auth())
      .expect(200);
    expect(scoped.body.data[0].totalStock).toBe(8);
    note('GET /products?locationId=branch: totalStock scoped to 8 OK');

    const search = await http()
      .get('/products/search?q=SKU-BL')
      .set(auth())
      .expect(200);
    expect(search.body.data).toHaveLength(1);
    note(`GET /products/search?q=SKU-BL: ${search.body.data.length} hit OK`);

    const items = await http().get('/products/items').set(auth()).expect(200);
    expect(items.body.data).toHaveLength(2);
    note(`GET /products/items: ${items.body.data.length} variants OK`);

    const detail = await http()
      .get(`/products/${productId}`)
      .set(auth())
      .expect(200);
    const red = detail.body.data.items.find((i: any) => i.sku === 'SKU-RED');
    expect(red.stockDetails).toHaveLength(2);
    note(`GET /products/:id: stockDetails=${red.stockDetails.length} OK`);

    // Từ refactor Location, hai bộ lọc độc lập nhau: chỉ lọc theo loại thì thu hẹp tới mọi địa điểm thuộc loại đó.
    const byKind = await http()
      .get('/products?locationType=BRANCH')
      .set(auth())
      .expect(200);
    expect(byKind.body.data[0].totalStock).toBe(8);
    note('GET /products?locationType=BRANCH: every branch, totalStock 8 OK');
  });

  it('runs the inventory routes, including the low-stock filter', async () => {
    const all = await http().get('/inventory').set(auth()).expect(200);
    expect(all.body.pagination.total).toBe(2);
    expect(all.body.data[0].location).toBeTruthy();
    note(
      `GET /inventory: ${all.body.pagination.total} rows, location object OK`,
    );

    const branchRow = all.body.data.find(
      (r: any) => r.location.type === 'BRANCH',
    );
    await http()
      .patch(`/inventory/${branchRow.id}/min-stock`)
      .set(auth())
      .send({ minStock: 10 })
      .expect(200);

    const low = await http()
      .get('/inventory?isLowStock=true')
      .set(auth())
      .expect(200);
    expect(low.body.pagination.total).toBe(1);
    note(
      `GET /inventory?isLowStock=true: ${low.body.pagination.total} row (stock 8 <= min 10) OK - Prisma field reference works`,
    );

    const added = await http()
      .post('/inventory')
      .set(auth())
      .send({
        locationId: branchId,
        productItemId: itemBId,
      })
      .expect(201);
    await http()
      .post('/inventory')
      .set(auth())
      .send({
        locationId: branchId,
        productItemId: itemBId,
      })
      .expect(409);
    note('POST /inventory + duplicate: 201 then 409 OK');

    const removed = await http()
      .delete(`/inventory/${added.body.data.id}`)
      .set(auth())
      .expect(200);
    expect(removed.body).toEqual({ success: true });
    note('DELETE /inventory/:id → {success:true} OK');

    await http().delete(`/inventory/${branchRow.id}`).set(auth()).expect(400);
    note('DELETE /inventory/:id with stock > 0: 400 OK');
  });

  it('manages a staff account end to end', async () => {
    const role = await http()
      .post('/roles')
      .set(auth())
      .send({
        name: 'Thu ngân',
        permissions: [
          { resource: 'stock_movement', action: 'create' },
          { resource: 'stock_movement', action: 'read' },
          { resource: 'stock_movement', action: 'update' },
          { resource: 'stock_movement', action: 'approve' },
          { resource: 'stock_movement', action: 'receive' },
        ],
      })
      .expect(201);
    roleId = role.body.data.id;

    await http()
      .post('/users')
      .set(auth())
      .send({ phoneNumber: '0651234567', roleId, branchId })
      .expect(400);
    note('POST /users with VoIP prefix 065: 400 OK (phone validator wired)');

    // Thuê và cấp quyền truy cập là hai lệnh, như hệ cũ: POST /users ghi nhân viên vào sổ không có mật khẩu, POST /users/:id/account mới bật đăng nhập.
    const staff = await http()
      .post('/users')
      .set(auth())
      .send({ phoneNumber: PHONE_STAFF, roleId, branchId })
      .expect(201);
    staffId = staff.body.data.id;
    expect(staff.body.data.status).toBe('INACTIVE');

    const beforeAccount = await prisma.user.findUnique({
      where: { id: staffId },
      select: { password: true },
    });
    expect(beforeAccount?.password).toBeNull();
    // Chưa có mật khẩu nghĩa là không đăng nhập được, dù đúng số điện thoại.
    await http()
      .post('/auth/login')
      .send({ phoneNumber: PHONE_STAFF, password: 'password123' })
      .expect(401);

    // Trường password trên POST /users bị whitelist của ValidationPipe âm thầm loại bỏ thay vì đặt mật khẩu - ghim lại để việc tách này không bị hồi quy.
    expect(staff.body.data).not.toHaveProperty('password');

    await http()
      .post(`/users/${staffId}/account`)
      .set(auth())
      .send({ newPassword: 'password123', reEnterPassword: 'password123' })
      .expect(201);
    const activated = await http()
      .post('/auth/login')
      .send({ phoneNumber: PHONE_STAFF, password: 'password123' })
      .expect(201);
    expect(activated.body.data.accessToken).toEqual(expect.any(String));
    note('hire → INACTIVE, no login; POST /users/:id/account activates OK');

    const list = await http().get('/users').set(auth()).expect(200);
    expect(list.body.pagination.total).toBe(1);
    note(
      `GET /users: paginated, total=${list.body.pagination.total} (owner excluded) OK`,
    );

    const searched = await http()
      .get('/users?search=098765')
      .set(auth())
      .expect(200);
    expect(searched.body.pagination.total).toBe(1);
    note('GET /users?search: OK');

    // Số chỗ nhân viên bị tính phí nên thuê bị giới hạn bởi gói, giống chi nhánh và sản phẩm. Ghim vào số nhân viên đang có rồi thả ra - phần còn lại của suite thuê thêm hai người.
    await prisma.subscription.updateMany({
      where: { tenantId },
      data: { quotaSnapshotMaxUsers: 1 },
    });
    const overQuota = await http()
      .post('/users')
      .set(auth())
      .send({ phoneNumber: '0987650008', roleId, branchId })
      .expect(400);
    expect(overQuota.body.code).toBe('PLAN_QUOTA_EXCEEDED');
    await prisma.subscription.updateMany({
      where: { tenantId },
      data: { quotaSnapshotMaxUsers: 10 },
    });
    note('POST /users past the plan seat limit: 400 OK');

    // Email là duy nhất trong mỗi shop và được kiểm khi thuê - không chỉ khi sửa, nơi bản trùng từng nằm im cho tới khi có người mở bản ghi.
    await http()
      .patch(`/users/${staffId}`)
      .set(auth())
      .send({ email: 'An.Tran@Example.com' })
      .expect(200);
    const dupEmail = await http()
      .post('/users')
      .set(auth())
      // Cố ý khác chữ hoa/thường: @NormalizeEmail chuyển về chữ thường trước khi so sánh.
      .send({
        phoneNumber: '0987650008',
        email: 'an.tran@example.com',
        roleId,
        branchId,
      })
      .expect(409);
    expect(dupEmail.body.code).toBe('EMAIL_ALREADY_IN_USE');
    note('POST /users with an email already in the shop: 409 OK (case-folded)');

    await http()
      .patch(`/users/${staffId}`)
      .set(auth())
      .send({
        profile: {
          firstName: 'Trần',
          lastName: 'An',
          identificationId: '079195001234',
          gender: 'MALE',
        },
      })
      .expect(400);
    note('PATCH /users/:id CCCD vs gender mismatch: 400 OK');

    const updated = await http()
      .patch(`/users/${staffId}`)
      .set(auth())
      .send({
        profile: {
          firstName: 'Trần',
          lastName: 'An',
          identificationId: '079195001234',
          gender: 'FEMALE',
          dob: '1995-03-04',
        },
        warehouseId,
      })
      .expect(200);
    expect(updated.body.data.branchId).toBeNull();
    expect(updated.body.data.warehouseId).toBe(warehouseId);
    expect(updated.body.data.profile.identificationId).toBe('079195001234');
    note('PATCH /users/:id profile + posting swap (branch cleared): OK');

    await http()
      .patch(`/users/${staffId}/account/deactivate`)
      .set(auth())
      .expect(200);
    const afterDeactivate = await prisma.user.findUnique({
      where: { id: staffId },
      select: { status: true, password: true },
    });
    expect(afterDeactivate?.status).toBe('INACTIVE');
    expect(afterDeactivate?.password).toBeNull();
    note('deactivate: status INACTIVE + password cleared OK');

    await http()
      .post(`/users/${staffId}/account`)
      .set(auth())
      .send({ newPassword: 'newpass123', reEnterPassword: 'nope' })
      .expect(400);
    await http()
      .post(`/users/${staffId}/account`)
      .set(auth())
      .send({ newPassword: 'newpass123', reEnterPassword: 'newpass123' })
      .expect(201);
    note('re-activate account (mismatch 400, then 201) OK');

    // Đưa họ về lại chi nhánh cho kịch bản phiếu chuyển kho bên dưới.
    await http()
      .patch(`/users/${staffId}`)
      .set(auth())
      .send({ branchId })
      .expect(200);
  });

  it('runs an EXPORT movement from warehouse to branch', async () => {
    const created = await http()
      .post('/stock-movements')
      .set(auth())
      .send({
        movementType: 'EXPORT',
        fromLocationId: warehouseId,
        toLocationId: branchId,
        details: [{ productItemId: itemAId, quantity: 20 }],
      })
      .expect(201);
    const id = created.body.data.id;
    expect(created.body.data.status).toBe('DRAFT');
    expect(created.body.data.totalPrice).toBe(20 * 120000);
    note(
      `POST /stock-movements EXPORT: DRAFT, totalPrice=${created.body.data.totalPrice} (cost price defaulted) OK`,
    );

    await http().patch(`/stock-movements/${id}/ship`).set(auth()).expect(409);
    note('ship from DRAFT: 409 OK (state machine enforced)');

    await http().patch(`/stock-movements/${id}/open`).set(auth()).expect(200);
    await http().patch(`/stock-movements/${id}/close`).set(auth()).expect(200);
    await http().patch(`/stock-movements/${id}/ship`).set(auth()).expect(200);

    const afterShip = await prisma.inventory.findFirst({
      where: { tenantId, locationId: warehouseId, productItemId: itemAId },
      select: { stock: true },
    });
    expect(afterShip?.stock).toBe(30);
    note(`ship: warehouse 50 → ${afterShip?.stock} OK`);

    // Giao thiếu: 18 trên 20 về tới nơi.
    await http()
      .patch(`/stock-movements/${id}/receive`)
      .set(auth())
      .send({ details: [{ productItemId: itemAId, receivedQuantity: 18 }] })
      .expect(200);

    const atBranch = await prisma.inventory.findFirst({
      where: { tenantId, locationId: branchId, productItemId: itemAId },
      select: { stock: true },
    });
    expect(atBranch?.stock).toBe(26);
    note(`receive 18 of 20: branch 8 → ${atBranch?.stock} OK (short delivery)`);
  });

  it('returns stock when an in-transit movement is cancelled', async () => {
    const created = await http()
      .post('/stock-movements')
      .set(auth())
      .send({
        movementType: 'EXPORT',
        fromLocationId: warehouseId,
        toLocationId: branchId,
        details: [{ productItemId: itemAId, quantity: 5 }],
      })
      .expect(201);
    const id = created.body.data.id;

    await http().patch(`/stock-movements/${id}/open`).set(auth()).expect(200);
    await http().patch(`/stock-movements/${id}/close`).set(auth()).expect(200);
    await http().patch(`/stock-movements/${id}/ship`).set(auth()).expect(200);
    await http().patch(`/stock-movements/${id}/cancel`).set(auth()).expect(200);

    const back = await prisma.inventory.findFirst({
      where: { tenantId, locationId: warehouseId, productItemId: itemAId },
      select: { stock: true },
    });
    expect(back?.stock).toBe(30);
    note(`cancel while IN_TRANSIT: warehouse back to ${back?.stock} OK`);
  });

  it('refuses to ship more than the source holds', async () => {
    const created = await http()
      .post('/stock-movements')
      .set(auth())
      .send({
        movementType: 'EXPORT',
        fromLocationId: warehouseId,
        toLocationId: branchId,
        details: [{ productItemId: itemAId, quantity: 9999 }],
      })
      .expect(400);
    expect(created.body.code).toBe('INSUFFICIENT_STOCK');
    note('create EXPORT beyond stock: 400 OK');
  });

  it('runs an IMPORT and enforces the supplier credit limit', async () => {
    const overLimit = await http()
      .post('/stock-movements')
      .set(auth())
      .send({
        movementType: 'IMPORT',
        fromSupplierId: supplierId,
        toLocationId: warehouseId,
        details: [
          { productItemId: itemAId, quantity: 100, importPrice: 150000 },
        ],
      })
      .expect(400);
    expect(overLimit.body.code).toBe('SUPPLIER_CREDIT_LIMIT_EXCEEDED');
    note('IMPORT over credit limit (15m > 10m): 400 OK');

    await http()
      .post('/stock-movements')
      .set(auth())
      .send({
        movementType: 'IMPORT',
        fromSupplierId: supplierId,
        toLocationId: warehouseId,
        details: [{ productItemId: itemAId, quantity: 1, importPrice: 900000 }],
      })
      .expect(400);
    note('IMPORT with importPrice > retailPrice: 400 OK');

    const created = await http()
      .post('/stock-movements')
      .set(auth())
      .send({
        movementType: 'IMPORT',
        fromSupplierId: supplierId,
        toLocationId: warehouseId,
        details: [
          { productItemId: itemBId, quantity: 60, importPrice: 130000 },
        ],
      })
      .expect(201);
    expect(created.body.data.status).toBe('PENDING');

    await http()
      .patch(`/stock-movements/${created.body.data.id}/receive`)
      .set(auth())
      .send({ details: [{ productItemId: itemBId, receivedQuantity: 60 }] })
      .expect(200);

    const supplier = await prisma.supplier.findUnique({
      where: { id: supplierId },
      select: { outstandingDebt: true },
    });
    expect(Number(supplier?.outstandingDebt)).toBe(7_800_000);
    note(
      `IMPORT received: supplier debt = ${Number(supplier?.outstandingDebt)} (60 × 130k) OK`,
    );

    const stocked = await prisma.inventory.findFirst({
      where: { tenantId, locationId: warehouseId, productItemId: itemBId },
      select: { stock: true },
    });
    expect(stocked?.stock).toBe(60);
    note(
      `IMPORT created the inventory line that did not exist: stock=${stocked?.stock} OK (adjustStock upsert)`,
    );

    const linked = await prisma.productItemSupplier.count({
      where: { productItemId: itemBId, supplierId },
    });
    expect(linked).toBe(1);
    note('IMPORT linked the supplier to the received variant OK');

    // Ở đây không gửi gì, và đúng như vậy: người nhận duy nhất sẽ là chủ shop - chính người vừa nhận hàng. iKiotMS-BE cũng loại người thực hiện theo cách đó. Cảnh báo bắn thật được phủ ở test kế tiếp.
    const selfWarned = await prisma.notification.count({
      where: { tenantId, title: { contains: 'hạn mức' } },
    });
    expect(selfWarned).toBe(0);
    note(
      'credit warning suppressed when the owner receives the goods themselves: OK (actor excluded, same as old)',
    );
  });

  it('warns the owner when somebody else pushes the debt past 75%', async () => {
    const supplierB = await http()
      .post('/suppliers')
      .set(auth())
      .send({ supplierName: 'NCC Beta', creditLimit: 1_000_000 })
      .expect(201);

    // Chuyển nhân viên sang kho để họ được nhận hàng ở đó.
    await http()
      .patch(`/users/${staffId}`)
      .set(auth())
      .send({ warehouseId })
      .expect(200);

    const created = await http()
      .post('/stock-movements')
      .set(auth())
      .send({
        movementType: 'IMPORT',
        fromSupplierId: supplierB.body.data.id,
        toLocationId: warehouseId,
        details: [{ productItemId: itemBId, quantity: 8, importPrice: 100000 }],
      })
      .expect(201);

    const login = await http()
      .post('/auth/login')
      .send({ phoneNumber: PHONE_STAFF, password: 'newpass123' })
      .expect(201);

    await http()
      .patch(`/stock-movements/${created.body.data.id}/receive`)
      .set(auth(login.body.data.accessToken))
      .send({ details: [{ productItemId: itemBId, receivedQuantity: 8 }] })
      .expect(200);

    const warned = await prisma.notification.count({
      where: { tenantId, title: { contains: 'hạn mức' } },
    });
    expect(warned).toBe(1);
    note(
      `credit warning: staff receipt pushes NCC Beta to 80% of limit → ${warned} notification to the owner OK`,
    );

    // Kích hoạt theo cạnh: lần nhận thứ hai nằm trên ngưỡng phải giữ im lặng.
    const again = await http()
      .post('/stock-movements')
      .set(auth())
      .send({
        movementType: 'IMPORT',
        fromSupplierId: supplierB.body.data.id,
        toLocationId: warehouseId,
        details: [{ productItemId: itemBId, quantity: 1, importPrice: 100000 }],
      })
      .expect(201);
    await http()
      .patch(`/stock-movements/${again.body.data.id}/receive`)
      .set(auth(login.body.data.accessToken))
      .send({ details: [{ productItemId: itemBId, receivedQuantity: 1 }] })
      .expect(200);

    const stillOne = await prisma.notification.count({
      where: { tenantId, title: { contains: 'hạn mức' } },
    });
    expect(stillOne).toBe(1);
    note(
      'second receipt above the line: still 1 notification OK (edge-triggered, no spam)',
    );

    await http()
      .patch(`/users/${staffId}`)
      .set(auth())
      .send({ branchId })
      .expect(200);
  });

  it('runs an ADJUST stocktake', async () => {
    const created = await http()
      .post('/stock-movements')
      .set(auth())
      .send({
        movementType: 'ADJUST',
        fromLocationId: branchId,
        details: [{ productItemId: itemAId, receivedQuantity: 24 }],
      })
      .expect(201);
    expect(created.body.data.status).toBe('PENDING');
    expect(created.body.data.details[0].quantity).toBe(26);
    note(
      `POST ADJUST: system quantity filled in from inventory = ${created.body.data.details[0].quantity} OK`,
    );

    await http()
      .patch(`/stock-movements/${created.body.data.id}/approve-adjust`)
      .set(auth())
      .expect(200);

    const after = await prisma.inventory.findFirst({
      where: { tenantId, locationId: branchId, productItemId: itemAId },
      select: { stock: true },
    });
    expect(after?.stock).toBe(24);
    note(`approve-adjust: branch 26 → ${after?.stock} (shrinkage of 2) OK`);
  });

  it('keeps a staff account inside its own location', async () => {
    const login = await http()
      .post('/auth/login')
      .send({ phoneNumber: PHONE_STAFF, password: 'newpass123' })
      .expect(201);
    const staffToken = login.body.data.accessToken;

    const list = await http()
      .get('/stock-movements')
      .set(auth(staffToken))
      .expect(200);
    note(
      `staff GET /stock-movements: sees ${list.body.pagination.total} of the tenant's movements (own branch only)`,
    );

    // Phiếu chuyển (từ 2026-09-09) lập được từ một trong hai đầu, nên tài khoản chi nhánh xin hàng từ kho là được phép. Phiếu kiểm kho chỉ lập tại nơi đếm hàng; phiếu này ở kho nên tài khoản không được lập.
    await http()
      .post('/stock-movements')
      .set(auth(staffToken))
      .send({
        movementType: 'ADJUST',
        fromLocationId: warehouseId,
        details: [{ productItemId: itemAId, quantity: 1 }],
      })
      .expect(403);
    note('staff filing a stocktake at another location: 403 OK');

    // products:read nằm trong quyền nền của mọi tài khoản nhân viên từ 2026-09-18 (STAFF_BASE_PERMISSIONS); suppliers:read không nằm trong quyền nền cũng không nằm trong role này.
    await http().get('/suppliers').set(auth(staffToken)).expect(403);
    note('staff without suppliers:read on /suppliers: 403 OK');
  });

  it('rings up a cash sale, computing the total server-side', async () => {
    const before = await prisma.inventory.findFirst({
      where: { tenantId, locationId: branchId, productItemId: itemAId },
      select: { stock: true },
    });

    const sale = await http()
      .post('/orders/pos')
      .set(auth())
      .send({
        branchId,
        paymentMethod: 'CASH',
        customerPay: 500_000,
        // Cố ý KHÔNG gửi grandTotal - và nếu gửi thì cũng bị bỏ qua.
        items: [{ productItemId: itemAId, quantity: 2 }],
      })
      .expect(201);

    expect(sale.body.data.order.grandTotal).toBe(400_000);
    expect(sale.body.data.order.change).toBe(100_000);
    expect(sale.body.data.order.status).toBe('COMPLETED');
    expect(sale.body.data.order.paymentReference).toMatch(/^ORD/);
    orderId = sale.body.data.order.id;
    note(
      `POST /orders CASH: total computed = ${sale.body.data.order.grandTotal}, change ${sale.body.data.order.change}, ref ${sale.body.data.order.paymentReference} OK`,
    );

    const after = await prisma.inventory.findFirst({
      where: { tenantId, locationId: branchId, productItemId: itemAId },
      select: { stock: true },
    });
    expect(after!.stock).toBe(before!.stock - 2);
    note(`sale decremented branch stock ${before!.stock} → ${after!.stock} OK`);

    // Tiền mặt có tiền thối là hai dòng: ngăn kéo nhận tờ tiền và trả lại một phần.
    const flows = await prisma.cashFlow.findMany({
      where: {
        tenantId,
        paymentReference: sale.body.data.order.paymentReference,
      },
      select: { flowType: true, amount: true, orderId: true },
    });
    expect(flows).toHaveLength(2);
    const income = flows.find((f) => f.flowType === 'INCOME')!;
    const expense = flows.find((f) => f.flowType === 'EXPENSE')!;
    expect(Number(income.amount)).toBe(500_000);
    expect(Number(expense.amount)).toBe(100_000);
    expect(income.orderId).toBe(orderId);
    expect(expense.orderId).toBeNull();
    note(
      'cash flows: INCOME 500k (linked) + EXPENSE 100k change (unlinked, keeps the unique index free for a refund) OK',
    );
  });

  it('prices a sale from the catalogue, whatever the till claims', async () => {
    // retailPrice của itemA là 200.000, còn request gửi 1đ. Đến 2026-09-06 server tin theo: `priceLines` chỉ chọn id/sku/productName và chuyển thẳng `unitPrice` của client, nên một giỏ có thể được tính với giá 0 trong khi hàng vẫn rời kệ và sổ ghi một giao dịch trông hợp lệ.
    await topUp(branchId, itemAId, 2);

    const sale = await http()
      .post('/orders/pos')
      .set(auth())
      .send({
        branchId,
        paymentMethod: 'CASH',
        customerPay: 400_000,
        items: [{ productItemId: itemAId, quantity: 2, unitPrice: 1 }],
      })
      .expect(201);

    expect(sale.body.data.order.grandTotal).toBe(400_000);
    expect(sale.body.data.order.items[0].unitPrice).toBe(200_000);
    note('POST /orders với unitPrice: 1 → server vẫn tính 200.000/đơn vị OK');

    // Giảm giá tay cả đơn bị chặn ở giá trị đơn. Chỉ `Math.max(0,…)` thì tổng không âm, nhưng giỏ nào vẫn có thể thanh toán ở 0.
    await topUp(branchId, itemAId, 1);
    const capped = await http()
      .post('/orders/pos')
      .set(auth())
      .send({
        branchId,
        paymentMethod: 'CASH',
        discountType: 'ORDER',
        discountValue: 999_999_999,
        customerPay: 0,
        items: [{ productItemId: itemAId, quantity: 1 }],
      })
      .expect(201);
    expect(capped.body.data.order.grandTotal).toBe(0);
    expect(Number(capped.body.data.order.discountValue)).toBe(999_999_999);
    note('giảm giá cả đơn vượt mức: tổng kẹp ở 0, không âm OK');
  });

  it('does not multiply a promotion across duplicate lines', async () => {
    // Lỗ hổng được vá: engine phân bổ theo `productItemId` còn đơn đọc lại theo TỪNG DÒNG, nên N dòng cùng một biến thể đều nhận tổng phần của mình. Khuyến mãi 10% chia cho mười dòng giống nhau thì giảm 100% và đơn ghi giá 0đ - trong khi mười món đã rời kệ.
    await topUp(branchId, itemAId, 10);

    const promo = await http()
      .post('/promotions')
      .set(auth())
      .send({
        promoName: 'Giảm 10% toàn đơn',
        discountType: 'PERCENT',
        discountValue: 10,
        startDate: new Date(Date.now() - 86_400_000).toISOString(),
        endDate: new Date(Date.now() + 86_400_000).toISOString(),
        status: 'ACTIVE',
        applicableRule: { type: 'all' },
      })
      .expect(201);

    // Mười dòng riêng, cùng biến thể - đúng như quầy quét từng món một.
    const sale = await http()
      .post('/orders/pos')
      .set(auth())
      .send({
        branchId,
        paymentMethod: 'CASH',
        customerPay: 1_800_000,
        items: Array.from({ length: 10 }, () => ({
          productItemId: itemAId,
          quantity: 1,
        })),
        appliedPromotions: [{ promotionId: promo.body.data.id }],
      })
      .expect(201);

    // 10 × 200.000 = 2.000.000, less 10% = 1.800.000. Not 0.
    expect(sale.body.data.order.grandTotal).toBe(1_800_000);
    expect(Number(sale.body.data.order.discountValue)).toBe(200_000);
    const perLine = sale.body.data.order.items.map((line: any) =>
      Number(line.discountAmount),
    );
    expect(perLine).toHaveLength(10);
    expect(perLine.every((amount: number) => amount === 20_000)).toBe(true);
    note(
      `10 dòng cùng SKU + KM 10%: tổng ${sale.body.data.order.grandTotal}, mỗi dòng giảm 20.000 (không phải 0đ) OK`,
    );

    await prisma.promotion.delete({ where: { id: promo.body.data.id } });
  });

  it('refuses a sale the branch cannot cover, and one the customer underpays', async () => {
    await http()
      .post('/orders/pos')
      .set(auth())
      .send({
        branchId,
        paymentMethod: 'CASH',
        items: [{ productItemId: itemAId, quantity: 9999 }],
      })
      .expect(400);
    note('POST /orders beyond branch stock: 400 OK');

    await http()
      .post('/orders/pos')
      .set(auth())
      .send({
        branchId,
        paymentMethod: 'CASH',
        customerPay: 1_000,
        items: [{ productItemId: itemAId, quantity: 1 }],
      })
      .expect(400);
    note('POST /orders with customerPay below the total: 400 OK');
  });

  it('returns a completed sale, putting stock and money back', async () => {
    const before = await prisma.inventory.findFirst({
      where: { tenantId, locationId: branchId, productItemId: itemAId },
      select: { stock: true },
    });

    await http()
      .patch(`/orders/${orderId}/status`)
      .set(auth())
      .send({ status: 'CANCELLED' })
      .expect(409);
    note('COMPLETED → CANCELLED: 409 OK (not a legal transition)');

    await http()
      .patch(`/orders/${orderId}/status`)
      .set(auth())
      .send({ status: 'RETURNED' })
      .expect(200);

    const after = await prisma.inventory.findFirst({
      where: { tenantId, locationId: branchId, productItemId: itemAId },
      select: { stock: true },
    });
    expect(after!.stock).toBe(before!.stock + 2);

    const refund = await prisma.cashFlow.findFirst({
      where: { tenantId, orderId, flowType: 'EXPENSE' },
      select: { amount: true },
    });
    expect(Number(refund!.amount)).toBe(400_000);
    note(
      `RETURNED: stock ${before!.stock} → ${after!.stock} and a 400k refund row OK`,
    );

    await http()
      .patch(`/orders/${orderId}/status`)
      .set(auth())
      .send({ status: 'COMPLETED' })
      .expect(409);
    note('RETURNED is terminal: 409 OK');
  });

  it('opens a SePay sale as PENDING and settles it offline', async () => {
    await http()
      .post('/orders/pos')
      .set(auth())
      .send({
        branchId,
        paymentMethod: 'SEPAY',
        items: [{ productItemId: itemAId, quantity: 1 }],
      })
      .expect(400);
    note('SEPAY sale without tenant banking configured: 400 OK');

    // Qua endpoint thật, không ghi trực tiếp. Trước khi `/tenant/banking` được port, shop không có cách nào cấu hình việc này, khiến bán SEPAY chỉ làm được bằng UPDATE tay - seed ở đây từng là cách làm tay đó.
    const banked = await http()
      .put('/tenant/banking')
      .set(auth())
      .send({
        bankName: 'MB',
        accountNumber: '0000000000',
        accountName: 'SMOKE TEST',
      })
      .expect(200);
    expect(banked.body.data.banking.bankName).toBe('MB');
    // Secret không bao giờ nằm trong response, kể cả với shop sở hữu nó.
    expect(banked.body.data.bankingSepayWebhookApiKey).toBeUndefined();

    const mine = await http().get('/tenant/me').set(auth()).expect(200);
    expect(mine.body.data.banking.accountNumber).toBe('0000000000');
    expect(mine.body.data.hasSepayKey).toBe(false);
    expect(mine.body.data.bankingSepayWebhookApiKey).toBeUndefined();
    note('PUT /tenant/banking + GET /tenant/me: saved, secret withheld OK');

    // Operator được báo có tài khoản cần liên kết - nửa đầu của quy trình SePay làm tay, và là thông báo hệ thống (không tenant, không người nhận).
    const heads = await prisma.notification.findFirst({
      where: { type: 'SYSTEM_TENANT_BANK_UPDATED', tenantId: null },
      orderBy: { createdAt: 'desc' },
    });
    expect(heads?.description).toContain('MB');
    note('bank update raises a SYSTEM_TENANT_BANK_UPDATED notification OK');

    const unlinked = await http()
      .post('/orders/pos')
      .set(auth())
      .send({
        branchId,
        paymentMethod: 'SEPAY',
        items: [{ productItemId: itemAId, quantity: 1 }],
      })
      .expect(400);
    expect(unlinked.body.code).toBe('TENANT_SEPAY_NOT_LINKED');
    note('SEPAY sale on an account not linked to SePay: 400 OK');

    await prisma.tenant.update({
      where: { id: tenantId },
      data: { bankingSepayLinkedAt: new Date() },
    });

    const sale = await http()
      .post('/orders/pos')
      .set(auth())
      .send({
        branchId,
        paymentMethod: 'SEPAY',
        items: [{ productItemId: itemAId, quantity: 1 }],
      })
      .expect(201);
    expect(sale.body.data.order.status).toBe('PENDING');
    expect(sale.body.data.qrUrl).toContain('img.vietqr.io');
    note(
      'POST /orders SEPAY: PENDING + QR built from the tenant bank details OK',
    );

    const settled = await http()
      .post(`/orders/${sale.body.data.order.id}/pay-offline`)
      .set(auth())
      .send({ paymentMethod: 'CASH', customerPay: 200_000 })
      .expect(200);
    expect(settled.body.data.status).toBe('COMPLETED');
    expect(settled.body.data.paymentMethod).toBe('CASH');
    const offline = await prisma.order.findUniqueOrThrow({
      where: { id: sale.body.data.order.id },
      select: { paymentStatus: true },
    });
    expect(offline.paymentStatus).toBe('PAID');
    note('pay-offline: SEPAY order settled as CASH, COMPLETED OK');

    await http()
      .post(`/orders/${sale.body.data.order.id}/pay-offline`)
      .set(auth())
      .send({ paymentMethod: 'CASH' })
      .expect(409);
    note('pay-offline twice: 409 OK (cannot double-charge)');
  });

  it('settles a SePay sale from the webhook', async () => {
    // Cấp webhook key là việc của admin nền tảng, qua route thật. Route cũ ghi SUPER_ADMIN trong comment nhưng không thi hành gì, nên tài khoản có `tenants:update` nào cũng ghi được key của shop khác - thứ định danh tenant với webhook thanh toán. Cả hai nửa đều được khẳng định ở đây.
    const admin = await prisma.user.create({
      data: {
        phoneNumber: PHONE_ADMIN,
        password: await bcrypt.hash('password123', 10),
        systemRole: 'ADMIN',
        status: 'ACTIVE',
        tenantId: null,
      },
      select: { id: true },
    });
    adminId = admin.id;

    await http()
      .put(`/tenant/${tenantId}/sepay-key`)
      .set(auth())
      .send({ sepayWebhookApiKey: 'stolen' })
      .expect(403);
    note('TENANT_OWNER setting a SePay key: 403 OK (old system allowed it)');

    const adminLogin = await http()
      .post('/auth/login')
      .send({ phoneNumber: PHONE_ADMIN, password: 'password123' })
      .expect(201);

    await http()
      .put(`/tenant/${tenantId}/sepay-key`)
      .set(auth(adminLogin.body.data.accessToken))
      .send({ sepayWebhookApiKey: 'smoke-webhook-key' })
      .expect(200);

    const linked = await http().get('/tenant/me').set(auth()).expect(200);
    expect(linked.body.data.hasSepayKey).toBe(true);
    note(
      'admin sets the SePay key; shop sees hasSepayKey=true, never the key OK',
    );

    const sale = await http()
      .post('/orders/pos')
      .set(auth())
      .send({
        branchId,
        paymentMethod: 'SEPAY',
        items: [{ productItemId: itemAId, quantity: 1 }],
      })
      .expect(201);
    const reference = sale.body.data.order.paymentReference;

    // Key lạ: trả 200 để SePay ngừng gọi lại, nhưng không quyết toán gì.
    const unknown = await http()
      .post('/webhook/sepay/order')
      .set({ Authorization: 'Apikey wrong-key' })
      .send({ transferType: 'in', content: reference, transferAmount: 200_000 })
      .expect(200);
    expect(unknown.body.success).toBe(false);
    note('webhook with an unknown API key: 200 + success:false OK');

    const paid = await http()
      .post('/webhook/sepay/order')
      .set({ Authorization: 'Apikey smoke-webhook-key' })
      .send({
        transferType: 'in',
        content: `Chuyen khoan ${reference}`,
        transferAmount: 200_000,
        id: 987654,
      })
      .expect(200);
    expect(paid.body.success).toBe(true);

    const settled = await prisma.order.findUnique({
      where: { id: sale.body.data.order.id },
      select: { status: true, sepayTransactionId: true },
    });
    expect(settled!.status).toBe('COMPLETED');
    // Khóa duy nhất nối đơn này với một dòng trên sao kê ngân hàng. Bị mất ở lần port đầu, khôi phục 2026-08-26 - cũng được giữ trên dòng tiền vì đối soát thực sự đọc chỗ đó.
    expect(settled!.sepayTransactionId).toBe('987654');
    const incomeRow = await prisma.cashFlow.findFirstOrThrow({
      where: { orderId: sale.body.data.order.id, flowType: 'INCOME' },
      select: { sepayTransactionId: true },
    });
    expect(incomeRow.sepayTransactionId).toBe('987654');
    note(
      'webhook: reference extracted from free text, order COMPLETED, SePay transaction id stored on order + cash flow OK',
    );

    const replay = await http()
      .post('/webhook/sepay/order')
      .set({ Authorization: 'Apikey smoke-webhook-key' })
      .send({
        transferType: 'in',
        content: reference,
        transferAmount: 200_000,
        id: 987654,
      })
      .expect(200);
    expect(replay.body.success).toBe(false);
    const flowCount = await prisma.cashFlow.count({
      where: { tenantId, orderId: sale.body.data.order.id, flowType: 'INCOME' },
    });
    expect(flowCount).toBe(1);
    note('webhook replay: refused, still exactly 1 income row OK');
  });

  it('settles a SePay sale through the shared webhook, by account number', async () => {
    process.env.SEPAY_ORDER_WEBHOOK_API_KEY = 'smoke-shared-key';
    const otherShop = await prisma.tenant.create({
      data: {
        name: `${TENANT_NAME} (other shop)`,
        bankingAccountNumber: '7777777777',
      },
      select: { id: true },
    });
    try {
      const taken = await http()
        .put('/tenant/banking')
        .set(auth())
        .send({
          bankName: 'MB',
          accountNumber: '777 777 7777',
          accountName: 'X',
        })
        .expect(409);
      expect(taken.body.code).toBe('TENANT_BANKING_ACCOUNT_TAKEN');
      note(
        "PUT /tenant/banking with another shop's number (typed with spaces): 409 OK",
      );

      const sale = await http()
        .post('/orders/pos')
        .set(auth())
        .send({
          branchId,
          paymentMethod: 'SEPAY',
          items: [{ productItemId: itemAId, quantity: 1 }],
        })
        .expect(201);
      const reference = sale.body.data.order.paymentReference;

      const pending = await http()
        .put('/tenant/banking')
        .set(auth())
        .send({ bankName: 'MB', accountNumber: '1111111111', accountName: 'X' })
        .expect(409);
      expect(pending.body.code).toBe('TENANT_BANKING_HAS_PENDING_SEPAY');
      note('changing the account while a SePay QR waits: 409 OK');

      const wrongAccount = await http()
        .post('/webhook/sepay/order')
        .set({ Authorization: 'Apikey smoke-shared-key' })
        .send({
          transferType: 'in',
          accountNumber: '7777777777',
          content: reference,
          transferAmount: 200_000,
          id: 111001,
        })
        .expect(200);
      expect(wrongAccount.body.success).toBe(false);
      const unknownAccount = await http()
        .post('/webhook/sepay/order')
        .set({ Authorization: 'Apikey smoke-shared-key' })
        .send({
          transferType: 'in',
          accountNumber: '9999999999',
          content: reference,
          transferAmount: 200_000,
          id: 111002,
        })
        .expect(200);
      expect(unknownAccount.body.success).toBe(false);
      const stillPending = await prisma.order.findUniqueOrThrow({
        where: { id: sale.body.data.order.id },
        select: { status: true },
      });
      expect(stillPending.status).toBe('PENDING');
      note(
        "shared webhook, another shop's / no shop's account: 200, nothing settled OK",
      );

      const paid = await http()
        .post('/webhook/sepay/order')
        .set({ Authorization: 'Apikey smoke-shared-key' })
        .send({
          transferType: 'in',
          accountNumber: '0000000000',
          content: `TT ${reference}`,
          transferAmount: 200_000,
          id: 111003,
        })
        .expect(200);
      expect(paid.body.success).toBe(true);
      const settled = await prisma.order.findUniqueOrThrow({
        where: { id: sale.body.data.order.id },
        select: { status: true, paymentStatus: true, sepayTransactionId: true },
      });
      expect(settled).toEqual({
        status: 'COMPLETED',
        paymentStatus: 'PAID',
        sepayTransactionId: '111003',
      });
      note("shared webhook, the shop's own account: order COMPLETED + PAID OK");

      const before = await prisma.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { bankingSepayWebhookApiKey: true },
      });
      await http()
        .put('/tenant/banking')
        .set(auth())
        .send({ bankName: 'MB', accountNumber: '1111111111', accountName: 'X' })
        .expect(200);
      const moved = await http().get('/tenant/me').set(auth()).expect(200);
      expect(moved.body.data.hasSepayKey).toBe(false);
      note('a new account number unlinks the shop, key included OK');
      await prisma.tenant.update({
        where: { id: tenantId },
        data: {
          bankingAccountNumber: '0000000000',
          bankingSepayWebhookApiKey: before.bankingSepayWebhookApiKey,
        },
      });
    } finally {
      delete process.env.SEPAY_ORDER_WEBHOOK_API_KEY;
      await prisma.tenant.delete({ where: { id: otherShop.id } });
    }
  });

  it('prices a cart against a promotion and commits it once', async () => {
    const promotion = await http()
      .post('/promotions')
      .set(auth())
      .send({
        promoName: 'Giảm 10% toàn shop',
        discountType: 'PERCENT',
        discountValue: 10,
        maxDiscountAmount: 50_000,
        applicableRule: { type: 'all' },
        startDate: '2026-08-01T00:00:00.000Z',
        endDate: '2026-12-31T00:00:00.000Z',
        usageLimit: 1,
      })
      .expect(201);
    promotionId = promotion.body.data.id;
    expect(promotion.body.data.applicableRule.type).toBe('all');
    note('POST /promotions: OK');

    const cart = {
      branchId,
      items: [{ productItemId: itemAId, quantity: 3 }],
    };

    const candidates = await http()
      .post('/promotions/candidates')
      .set(auth())
      .send(cart)
      .expect(200);
    expect(candidates.body.data.systemPromotions).toHaveLength(1);
    expect(candidates.body.data.systemPromotions[0].eligible).toBe(true);
    note(
      `POST /promotions/candidates: 1 tenant-wide candidate, preview ${candidates.body.data.systemPromotions[0].previewDiscount} OK`,
    );

    const calculated = await http()
      .post('/promotions/calculate')
      .set(auth())
      .send({ ...cart, promotionIds: [promotionId] })
      .expect(200);
    // 10% of 600k = 60k, capped at 50k.
    expect(calculated.body.data.totalDiscount).toBe(50_000);
    expect(calculated.body.data.grandTotal).toBe(550_000);
    note(
      'POST /promotions/calculate: 10% of 600k capped at maxDiscountAmount 50k OK',
    );

    // Quầy chỉ gửi tên khuyến mãi, không gửi breakdown, discountValue hay discountType. Mọi thứ hệ cũ bắt client gửi lại giờ server tự tính, nên đây là test hồi quy cho đơn từng bị tính đủ giá dù màn hình hiện giảm giá.
    const withDiscount = await http()
      .post('/orders/pos')
      .set(auth())
      .send({
        branchId,
        paymentMethod: 'CASH',
        items: [{ productItemId: itemAId, quantity: 3 }],
        appliedPromotions: [{ promotionId }],
      })
      .expect(201);
    const discounted = withDiscount.body.data.order;
    expect(discounted.grandTotal).toBe(550_000);
    expect(discounted.discountType).toBe('PROMOTION');
    expect(Number(discounted.discountValue)).toBe(50_000);
    expect(discounted.items[0].discountAmount).toBe(50_000);
    expect(discounted.appliedPromotions[0].promoName).toBe(
      'Giảm 10% toàn shop',
    );
    expect(discounted.appliedPromotions[0].discountAmount).toBe(50_000);
    note(
      'POST /orders with only a promotion id: server prices it - total 550k, line discount 50k, promoName filled in OK',
    );

    // Gửi payload theo dạng cũ phải ra cùng số: key thừa bị ValidationPipe loại bỏ, còn số tiền client gửi thì không được đọc.
    const legacyShape = await http()
      .post('/orders/pos')
      .set(auth())
      .send({
        branchId,
        paymentMethod: 'CASH',
        discountValue: 999_999,
        items: [
          {
            productItemId: itemAId,
            quantity: 3,
            discountAmount: 0,
          },
        ],
        appliedPromotions: [
          { promotionId, promoName: 'nói dối', discountAmount: 999_999 },
        ],
      })
      .expect(201);
    expect(legacyShape.body.data.order.grandTotal).toBe(550_000);
    expect(Number(legacyShape.body.data.order.discountValue)).toBe(50_000);
    note(
      'POST /orders with the old payload (bogus amounts): ignored, still 550k OK',
    );

    // Giảm giá tay cả đơn và khuyến mãi dùng chung một cột.
    const conflict = await http()
      .post('/orders/pos')
      .set(auth())
      .send({
        branchId,
        paymentMethod: 'CASH',
        discountType: 'ORDER',
        discountValue: 10_000,
        items: [{ productItemId: itemAId, quantity: 1 }],
        appliedPromotions: [{ promotionId }],
      })
      .expect(400);
    expect(conflict.body.code).toBe('ORDER_DISCOUNT_CONFLICT');
    note('POST /orders mixing an ORDER discount with a promotion: 400 OK');

    const applied = await http()
      .post('/promotions/apply')
      .set(auth())
      .send({
        ...cart,
        orderId: withDiscount.body.data.order.id,
        promotionIds: [promotionId],
      })
      .expect(200);
    expect(applied.body.data.appliedPromotions).toHaveLength(1);

    const after = await prisma.promotion.findUnique({
      where: { id: promotionId },
      select: { usedCount: true },
    });
    expect(after!.usedCount).toBe(1);
    note('POST /promotions/apply: usedCount 0 → 1 and a log written OK');

    const logs = await http()
      .get(`/promotions/${promotionId}/logs`)
      .set(auth())
      .expect(200);
    expect(logs.body.pagination.total).toBe(1);
    expect(logs.body.data[0].paymentReference).toMatch(/^ORD/);
    note('GET /promotions/:id/logs: 1 entry, order reference resolved OK');
  });

  it('stops a promotion being used past its limit', async () => {
    const cart = {
      branchId,
      items: [{ productItemId: itemAId, quantity: 1 }],
    };

    // usageLimit là 1 và test trước đã dùng hết, nên nó không còn đủ điều kiện.
    const calc = await http()
      .post('/promotions/calculate')
      .set(auth())
      .send({ ...cart, promotionIds: [promotionId] })
      .expect(400);
    expect(calc.body.code).toBe('PROMOTION_NOT_ELIGIBLE');
    note('exhausted promotion: 400 with a reason OK');

    const candidates = await http()
      .post('/promotions/candidates')
      .set(auth())
      .send(cart)
      .expect(200);
    expect(candidates.body.data.systemPromotions[0].eligible).toBe(false);
    note(
      `candidates still lists it, ineligible: "${candidates.body.data.systemPromotions[0].reason}" OK`,
    );
  });

  it('scopes promotions to the branches they name', async () => {
    const other = await http()
      .post('/branches')
      .set(auth())
      .send({ name: 'CN Q7', phoneNumber: ['0987650012'] })
      .expect(201);

    await http()
      .post('/promotions')
      .set(auth())
      .send({
        promoName: 'Chỉ CN Q7',
        branchIds: [other.body.data.id],
        discountType: 'FIXED_AMOUNT',
        discountValue: 20_000,
        applicableRule: { type: 'all' },
        startDate: '2026-08-01T00:00:00.000Z',
        endDate: '2026-12-31T00:00:00.000Z',
      })
      .expect(201);

    const atQ1 = await http()
      .post('/promotions/candidates')
      .set(auth())
      .send({
        branchId,
        items: [{ productItemId: itemAId, quantity: 1 }],
      })
      .expect(200);
    expect(atQ1.body.data.branchPromotions).toHaveLength(0);
    note('branch-scoped promotion is not a candidate at another branch OK');

    await http()
      .post('/promotions')
      .set(auth())
      .send({
        promoName: 'Sai ngày',
        discountType: 'PERCENT',
        discountValue: 10,
        applicableRule: { type: 'all' },
        startDate: '2026-12-31T00:00:00.000Z',
        endDate: '2026-08-01T00:00:00.000Z',
      })
      .expect(400);
    note('promotion ending before it starts: 400 OK');

    await http()
      .post('/promotions')
      .set(auth())
      .send({
        promoName: 'Cap sai kiểu',
        discountType: 'FIXED_AMOUNT',
        discountValue: 10_000,
        maxDiscountAmount: 5_000,
        applicableRule: { type: 'all' },
        startDate: '2026-08-01T00:00:00.000Z',
        endDate: '2026-12-31T00:00:00.000Z',
      })
      .expect(400);
    note('maxDiscountAmount on a FIXED_AMOUNT promotion: 400 OK');
  });

  it('manages customers and attaches a walk-in to anonymous sales', async () => {
    const walkIn = await prisma.customer.findFirst({
      where: { tenantId, customerCode: 'KH_VANGLAI' },
      select: { id: true, name: true },
    });
    expect(walkIn).toBeTruthy();
    note(`walk-in customer auto-created once: "${walkIn!.name}" OK`);

    const created = await http()
      .post('/customers')
      .set(auth())
      .send({
        name: 'Nguyễn Văn A',
        phone: '0912345678',
        customerCode: 'KH001',
      })
      .expect(201);

    await http()
      .post('/customers')
      .set(auth())
      .send({ name: 'Trùng mã', customerCode: 'KH001' })
      .expect(409);
    note('duplicate customerCode: 409 OK');

    const list = await http()
      .get('/customers?search=0912')
      .set(auth())
      .expect(200);
    expect(list.body.pagination.total).toBe(1);
    note('GET /customers?search: OK');

    const sale = await http()
      .post('/orders/pos')
      .set(auth())
      .send({
        branchId,
        customerId: created.body.data.id,
        paymentMethod: 'CASH',
        items: [{ productItemId: itemAId, quantity: 1 }],
      })
      .expect(201);
    expect(sale.body.data.order.customer.id).toBe(created.body.data.id);

    const withOrders = await http()
      .get(`/customers?search=0912`)
      .set(auth())
      .expect(200);
    expect(withOrders.body.data[0].orders).toHaveLength(1);
    note('GET /customers carries the order history OK');

    await http()
      .delete(`/customers/${created.body.data.id}`)
      .set(auth())
      .expect(200);
    await http()
      .get(`/customers/${created.body.data.id}`)
      .set(auth())
      .expect(404);
    note('soft delete: gone from reads, row kept for the order OK');
  });

  it('refuses a promotion from another tenant on an order', async () => {
    // FK sẽ chấp nhận - đó là id khuyến mãi thật, chỉ không thuộc tenant này.
    const outsider = await prisma.promotion.findFirst({
      where: { tenantId: { not: tenantId } },
      select: { id: true },
    });

    // Trả 400, không phải 404 như trước: đơn không tự tra khuyến mãi nữa mà tính giỏ qua engine; id không nằm trong danh sách ứng viên đang hoạt động của tenant sẽ trả "đã hết hạn hoặc không áp dụng cho đơn này" - một thông điệp cho cả hai trường hợp, cũng là đáp án đúng cho id của tenant khác.
    const refused = await http()
      .post('/orders/pos')
      .set(auth())
      .send({
        branchId,
        paymentMethod: 'CASH',
        appliedPromotions: [
          {
            promotionId: outsider?.id ?? '11111111-1111-4111-8111-111111111111',
          },
        ],
        items: [{ productItemId: itemAId, quantity: 1 }],
      })
      .expect(400);
    expect(refused.body.code).toBe('PROMOTION_NOT_APPLICABLE');
    note("order carrying another tenant's promotion id: 400 OK");
  });

  // Engine giờ kiểm lại điều kiện, nên đơn không còn được dùng khuyến mãi mà bước xem trước đã từ chối. Code cũ chỉ kiểm id có tồn tại trong tenant.
  it('refuses an inactive promotion on an order', async () => {
    const paused = await prisma.promotion.create({
      data: {
        tenantId,
        promoName: 'Đã tạm dừng',
        discountType: 'PERCENT',
        discountValue: 50,
        minOrderValue: 0,
        applicableRuleType: 'all',
        startDate: new Date(Date.now() - 86_400_000),
        endDate: new Date(Date.now() + 86_400_000),
        status: 'INACTIVE',
        usedCount: 0,
      },
      select: { id: true },
    });

    const refused = await http()
      .post('/orders/pos')
      .set(auth())
      .send({
        branchId,
        paymentMethod: 'CASH',
        appliedPromotions: [{ promotionId: paused.id }],
        items: [{ productItemId: itemAId, quantity: 1 }],
      })
      .expect(400);
    expect(refused.body.code).toBe('PROMOTION_NOT_APPLICABLE');
    note('order claiming an INACTIVE promotion: 400 OK');
  });

  it('tells the client which permissions it holds', async () => {
    // Frontend không còn chặn màn hình theo *loại* tài khoản được nữa - mỗi shop tự định nghĩa role - nên `/auth/me` trả về tập quyền `JwtStrategy` vừa resolve cho chính request này, và UI dựa vào đó.
    await http()
      .patch(`/roles/${roleId}`)
      .set(auth())
      .send({
        permissions: [
          { resource: 'suppliers', action: 'read' },
          { resource: 'orders', action: 'read' },
        ],
      })
      .expect(200);

    const staffLogin = await http()
      .post('/auth/login')
      .send({ phoneNumber: PHONE_STAFF, password: 'newpass123' })
      .expect(201);
    const staffMe = await http()
      .get('/auth/me')
      .set(auth(staffLogin.body.data.accessToken))
      .expect(200);

    // Hai quyền của role, cộng với quyền nền mà mọi tài khoản nhân viên đều có (STAFF_BASE_PERMISSIONS, thêm 2026-09-18 để nhân viên mới ít nhất xem được danh mục và lịch của mình).
    expect(staffMe.body.data.permissions.sort()).toEqual(
      [
        ...new Set([
          'orders:read',
          'suppliers:read',
          ...STAFF_BASE_PERMISSIONS,
        ]),
      ].sort(),
    );
    expect(staffMe.body.data.systemRole).toBe('STAFF');
    note('GET /auth/me (staff): quyền của vai trò + quyền nền OK');

    // Rỗng với chủ shop, nghĩa là "không áp dụng" - họ bỏ qua guard hoàn toàn. Client đọc thành "không có quyền" sẽ khóa chủ shop khỏi chính shop của mình, đúng việc đã xảy ra trước khi ghi lại điều này.
    const ownerMe = await http().get('/auth/me').set(auth()).expect(200);
    expect(ownerMe.body.data.permissions).toEqual([]);
    expect(ownerMe.body.data.systemRole).toBe('TENANT_OWNER');
    note('GET /auth/me (chủ shop): permissions rỗng = "không áp dụng" OK');

    // Thu hồi một quyền có hiệu lực ở request kế tiếp, không cần đăng nhập lại.
    await http()
      .patch(`/roles/${roleId}`)
      .set(auth())
      .send({ permissions: [{ resource: 'orders', action: 'read' }] })
      .expect(200);
    const after = await http()
      .get('/auth/me')
      .set(auth(staffLogin.body.data.accessToken))
      .expect(200);
    expect(after.body.data.permissions).not.toContain('suppliers:read');
    expect(after.body.data.permissions.sort()).toEqual(
      [...new Set(['orders:read', ...STAFF_BASE_PERMISSIONS])].sort(),
    );
    note('thu hồi quyền: /auth/me phản ánh ngay trên token cũ OK');
  });

  it('scopes order reads to the branch a staff account works at', async () => {
    const login = await http()
      .post('/auth/login')
      .send({ phoneNumber: PHONE_STAFF, password: 'newpass123' })
      .expect(201);
    const staffToken = login.body.data.accessToken;

    // Role nhân viên chưa có orders:* - chỉ cấp đọc, không có view_all.
    await http()
      .patch(`/roles/${roleId}`)
      .set(auth())
      .send({
        permissions: [
          { resource: 'stock_movement', action: 'create' },
          { resource: 'stock_movement', action: 'read' },
          { resource: 'orders', action: 'read' },
        ],
      })
      .expect(200);

    const ownBranch = await http()
      .get('/orders')
      .set(auth(staffToken))
      .expect(200);
    const otherBranchOrders = ownBranch.body.data.filter(
      (o: any) => o.branchId !== branchId,
    );
    expect(otherBranchOrders).toHaveLength(0);
    note(
      `staff GET /orders: ${ownBranch.body.pagination.total} orders, all from their own branch OK`,
    );

    const ownerView = await http().get('/orders').set(auth()).expect(200);
    expect(ownerView.body.pagination.total).toBeGreaterThanOrEqual(
      ownBranch.body.pagination.total,
    );
    note('owner still sees every branch OK (view_all short-circuit)');

    // Bộ lọc truy vấn chỉ được thu hẹp phạm vi, không được thay thế nó. Đến 2026-09-06 code đọc `if (query.branchId) where.branchId = query.branchId`, nên ghi tên chi nhánh khác sẽ trả về toàn bộ sổ bán của chi nhánh đó - trong khi `GET /orders/:id` từ chối cùng các dòng. Dùng lại chi nhánh thứ hai mà test trước đã tạo - gói TRIAL giới hạn shop ở hai chi nhánh, nên tạo cái thứ ba sẽ bị quota chặn chứ không phải luật phạm vi.
    const otherBranch = await prisma.branch.findFirstOrThrow({
      where: {
        tenantId,
        id: { not: branchId },
        location: { status: 'ACTIVE' },
      },
      select: { id: true },
    });

    await http()
      .get('/orders')
      .query({ branchId: otherBranch.id })
      .set(auth(staffToken))
      .expect(403);
    note('staff GET /orders?branchId=<chi nhánh khác>: 403 OK');

    // Gửi lại chi nhánh của chính mình là bình thường - màn hình gửi đúng thứ đang hiển thị.
    await http()
      .get('/orders')
      .query({ branchId })
      .set(auth(staffToken))
      .expect(200);

    // Chủ shop không bị giới hạn phạm vi, nên chọn chi nhánh vẫn thu hẹp kết quả với họ.
    await http()
      .get('/orders')
      .query({ branchId: otherBranch.id })
      .set(auth())
      .expect(200);
    note('owner vẫn lọc được theo chi nhánh bất kỳ OK');
  });

  it('refuses to sell more than the shelf holds, from inside the write', async () => {
    const line = await prisma.inventory.findFirst({
      where: { tenantId, locationId: branchId, productItemId: itemAId },
      select: { stock: true },
    });

    await http()
      .post('/orders/pos')
      .set(auth())
      .send({
        branchId,
        paymentMethod: 'CASH',
        items: [
          {
            productItemId: itemAId,
            quantity: line!.stock + 1,
          },
        ],
      })
      .expect(400);

    const unchanged = await prisma.inventory.findFirst({
      where: { tenantId, locationId: branchId, productItemId: itemAId },
      select: { stock: true },
    });
    expect(unchanged!.stock).toBe(line!.stock);
    note(
      `oversell by 1 (${line!.stock} on hand): 400 and stock untouched OK (guard is in the UPDATE)`,
    );
  });

  it('keeps exactly one walk-in customer under concurrent anonymous sales', async () => {
    const sale = () =>
      http()
        .post('/orders/pos')
        .set(auth())
        .send({
          branchId,
          paymentMethod: 'CASH',
          items: [{ productItemId: itemAId, quantity: 1 }],
        });

    const results = await Promise.all([sale(), sale(), sale()]);
    for (const result of results) expect(result.status).toBe(201);

    const walkIns = await prisma.customer.count({
      where: { tenantId, customerCode: 'KH_VANGLAI' },
    });
    expect(walkIns).toBe(1);
    note(
      '3 concurrent anonymous sales → exactly 1 walk-in customer row OK (upsert, not find-then-create)',
    );
  });

  it('runs a cash drawer through a full day, including a handover', async () => {
    // Nhân viên cần quyền quầy cho kịch bản này.
    await http()
      .patch(`/roles/${roleId}`)
      .set(auth())
      .send({
        permissions: [
          { resource: 'orders', action: 'read' },
          { resource: 'cash_drawers', action: 'read_own' },
          { resource: 'cash_drawers', action: 'report' },
        ],
      })
      .expect(200);

    // Thu ngân thứ hai để bàn giao - thuê rồi cấp đăng nhập.
    const secondStaff = await http()
      .post('/users')
      .set(auth())
      .send({ phoneNumber: '0987650003', roleId, branchId })
      .expect(201);
    await http()
      .post(`/users/${secondStaff.body.data.id}/account`)
      .set(auth())
      .send({ newPassword: 'password123', reEnterPassword: 'password123' })
      .expect(201);

    const opened = await http()
      .post('/cash-drawer-sessions')
      .set(auth())
      .send({ branchId, staffId, openingAmount: 2_000_000 })
      .expect(201);
    secondStaffId = secondStaff.body.data.id;
    sessionId = opened.body.data.id;
    expect(opened.body.data.status).toBe('OPEN');
    expect(opened.body.data.openingAmount).toBe(2_000_000);
    expect(opened.body.data.currentStaff.id).toBe(staffId);
    note(
      `POST /cash-drawer-sessions: OPEN, float ${opened.body.data.openingAmount}, held by staff 1 OK`,
    );

    await http()
      .post('/cash-drawer-sessions')
      .set(auth())
      .send({ branchId, staffId, openingAmount: 1_000 })
      .expect(409);
    note('second drawer at the same branch: 409 OK (partial unique index)');

    const staffLogin = await http()
      .post('/auth/login')
      .send({ phoneNumber: PHONE_STAFF, password: 'newpass123' })
      .expect(201);
    const staffToken = staffLogin.body.data.accessToken;

    const second = await http()
      .post('/auth/login')
      .send({ phoneNumber: '0987650003', password: 'password123' })
      .expect(201);
    const secondToken = second.body.data.accessToken;

    // Danh sách cho ô chọn: thay cho `GET /users`, mà thu ngân không có quyền đọc.
    const eligible = await http()
      .get(`/cash-drawer-sessions/eligible-staff?branchId=${branchId}`)
      .set(auth())
      .expect(200);
    const eligibleIds = eligible.body.data.map((u: { id: string }) => u.id);
    expect(eligibleIds).toEqual(
      expect.arrayContaining([staffId, secondStaff.body.data.id]),
    );
    expect(eligible.body.data[0]).not.toHaveProperty('phoneNumber');
    expect(Object.keys(eligible.body.data[0].profile).sort()).toEqual([
      'firstName',
      'lastName',
    ]);
    await http()
      .get('/cash-drawer-sessions/eligible-staff')
      .set(auth(secondToken))
      .expect(403);
    note(
      'GET /cash-drawer-sessions/eligible-staff: names only for the opener, 403 without cash_drawers:open OK',
    );

    const candidates = await http()
      .get(`/cash-drawer-sessions/${sessionId}/handover-candidates`)
      .set(auth(staffToken))
      .expect(200);
    const candidateIds = candidates.body.data.map((u: { id: string }) => u.id);
    expect(candidateIds).toContain(secondStaff.body.data.id);
    expect(candidateIds).not.toContain(staffId);
    expect(candidates.body.data[0]).not.toHaveProperty('phoneNumber');
    // Người không giữ két không thấy phiên (read_own) nên không liệt kê được đồng nghiệp qua đây.
    await http()
      .get(`/cash-drawer-sessions/${sessionId}/handover-candidates`)
      .set(auth(secondToken))
      .expect(404);
    // Chủ shop thấy phiên nhưng không giữ két: cùng luật với shift log.
    await http()
      .get(`/cash-drawer-sessions/${sessionId}/handover-candidates`)
      .set(auth())
      .expect(403);
    note(
      'GET /cash-drawer-sessions/:id/handover-candidates: holder only, excludes self, names only OK',
    );

    // Chỉ người đang giữ ngăn kéo mới được ghi vào đó.
    await http()
      .post(`/cash-drawer-sessions/${sessionId}/shift-logs`)
      .set(auth(secondToken))
      .send({ type: 'START', amount: 2_000_000 })
      .expect(404);
    note('a cashier who never held the drawer cannot even see it: 404 OK');

    // END trước START là sai thứ tự.
    await http()
      .post(`/cash-drawer-sessions/${sessionId}/shift-logs`)
      .set(auth(staffToken))
      .send({ type: 'END', amount: 2_000_000 })
      .expect(409);
    note('END before START: 409 OK (sequence enforced)');

    await http()
      .post(`/cash-drawer-sessions/${sessionId}/shift-logs`)
      .set(auth(staffToken))
      .send({ type: 'START', amount: 2_000_000 })
      .expect(200);

    await http()
      .post(`/cash-drawer-sessions/${sessionId}/shift-logs`)
      .set(auth(staffToken))
      .send({ type: 'START', amount: 2_000_000 })
      .expect(409);
    note('a second START on the same shift: 409 OK');

    // Chốt giữa ca bị từ chối - log cuối là START.
    await http()
      .post(`/cash-drawer-sessions/${sessionId}/finalize`)
      .set(auth())
      .send({ finalAmount: 2_500_000 })
      .expect(409);
    note('finalize with a shift still open: 409 OK');

    // Bàn giao cho thu ngân thứ hai.
    await http()
      .post(`/cash-drawer-sessions/${sessionId}/shift-logs`)
      .set(auth(staffToken))
      .send({
        type: 'END',
        amount: 2_400_000,
        nextStaffId: secondStaff.body.data.id,
      })
      .expect(200);

    const afterHandover = await prisma.cashDrawerSession.findUnique({
      where: { id: sessionId },
      select: { currentStaffId: true, status: true },
    });
    expect(afterHandover!.currentStaffId).toBe(secondStaff.body.data.id);
    expect(afterHandover!.status).toBe('OPEN');
    note('handover: drawer passed to cashier 2, session still OPEN OK');

    // Thu ngân thứ nhất không còn giữ ngăn kéo nữa.
    await http()
      .post(`/cash-drawer-sessions/${sessionId}/shift-logs`)
      .set(auth(staffToken))
      .send({ type: 'START', amount: 2_400_000 })
      .expect(403);
    note('the outgoing cashier can no longer write to the drawer: 403 OK');

    await http()
      .post(`/cash-drawer-sessions/${sessionId}/shift-logs`)
      .set(auth(secondToken))
      .send({ type: 'START', amount: 2_400_000 })
      .expect(200);
    await http()
      .post(`/cash-drawer-sessions/${sessionId}/shift-logs`)
      .set(auth(secondToken))
      .send({ type: 'END', amount: 3_100_000 })
      .expect(200);
    note('cashier 2 worked a shift and closed it out OK');

    const finalized = await http()
      .post(`/cash-drawer-sessions/${sessionId}/finalize`)
      .set(auth())
      .send({ finalAmount: 3_100_000, note: 'Khớp' })
      .expect(200);
    expect(finalized.body.data.status).toBe('CLOSED');
    expect(finalized.body.data.finalLog.amount).toBe(3_100_000);
    expect(finalized.body.data.shiftLogs).toHaveLength(4);
    note(
      `finalize: CLOSED, final count ${finalized.body.data.finalLog.amount}, ${finalized.body.data.shiftLogs.length} shift logs OK`,
    );

    await http()
      .post(`/cash-drawer-sessions/${sessionId}/finalize`)
      .set(auth())
      .send({ finalAmount: 3_100_000 })
      .expect(409);
    note('finalize twice: 409 OK');
  });

  it('reconciles the closed drawer against the cash ledger', async () => {
    // Lỗ hổng được vá: phiên ghi số người *đếm* được, còn CashFlow ghi số *đã di chuyển*, và chưa từng có gì trừ hai số này cho nhau.
    const session = await prisma.cashDrawerSession.findUniqueOrThrow({
      where: { id: sessionId },
      select: { businessDate: true, openingAmount: true, finalLogAmount: true },
    });

    const first = await http()
      .get(`/cash-drawer-sessions/${sessionId}/reconciliation`)
      .set(auth())
      .expect(200);
    const report = first.body.data;

    // Khung ngày bán được kiểm trực tiếp theo offset +07:00 thay vì qua helper đã tạo ra nó - lệch một giờ ở đây sẽ đẩy mọi hóa đơn trước 07:00 sang ngăn kéo của ngày hôm trước, đúng lỗi mà cả tính năng này sinh ra để tìm.
    const dayStart = new Date(
      session.businessDate.getTime() - 7 * 60 * 60 * 1000,
    );
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
    expect(new Date(report.window.start).getTime()).toBe(dayStart.getTime());
    expect(new Date(report.window.end).getTime()).toBe(dayEnd.getTime());

    // Đọc sổ độc lập và kiểm endpoint khớp với nó.
    const flows = await prisma.cashFlow.findMany({
      where: {
        tenantId,
        locationId: branchId,
        paymentMethod: 'CASH',
        createdAt: { gte: dayStart, lt: dayEnd },
      },
      select: { flowType: true, amount: true },
    });
    const sum = (type: string) =>
      flows
        .filter((flow) =>
          type === 'INCOME'
            ? flow.flowType === 'INCOME'
            : flow.flowType !== 'INCOME',
        )
        .reduce((total, flow) => total + Number(flow.amount), 0);

    expect(report.cashIn).toBe(sum('INCOME'));
    expect(report.cashOut).toBe(sum('EXPENSE'));
    expect(report.openingAmount).toBe(Number(session.openingAmount));
    expect(report.expectedClosing).toBe(
      report.openingAmount + report.cashIn - report.cashOut,
    );
    expect(report.countedClosing).toBe(Number(session.finalLogAmount));
    expect(report.variance).toBe(
      report.countedClosing - report.expectedClosing,
    );
    note(
      `GET /:id/reconciliation: expected ${report.expectedClosing}, counted ${report.countedClosing}, variance ${report.variance} OK`,
    );

    // Bốn log ca (START, END+bàn giao, START, END) chia ngày thành năm đoạn; khoảng GAP độ dài 0 giữa bàn giao và START kế tiếp là một đoạn trong số đó.
    expect(report.segments.map((s: any) => s.kind)).toEqual([
      'OPENING',
      'SHIFT',
      'GAP',
      'SHIFT',
      'CLOSING',
    ]);
    expect(report.segments[1].staff.id).toBe(staffId);
    expect(report.segments[3].staff.id).toBe(secondStaffId);

    // Tính chất mà báo cáo dựa vào: ngày thiếu X và các đoạn chỉ ra vị trí.
    const summed = report.segments.reduce(
      (total: number, segment: any) => total + (segment.variance ?? 0),
      0,
    );
    expect(summed).toBe(report.variance);
    note(
      `segments ${report.segments.map((s: any) => `${s.kind}:${s.variance}`).join(' ')} sum to the session variance OK`,
    );

    // Tiền không phải mặt không bao giờ vào ngăn kéo nên được báo bên cạnh chênh lệch, không nằm trong đó.
    expect(
      report.nonCash.every((row: any) => row.paymentMethod !== 'CASH'),
    ).toBe(true);

    // Giờ chuyển tiền thật và kiểm báo cáo có theo: thêm một đơn tiền mặt tại chi nhánh này làm tăng số ngăn kéo phải có, còn tổng đã đếm giữ nguyên. Tồn được bù đúng bằng lượng đã bán nên tồn tịnh về 0, các test sau thấy đúng như mong đợi.
    await topUp(branchId, itemAId, 1);
    await http()
      .post('/orders/pos')
      .set(auth())
      .send({
        branchId,
        paymentMethod: 'CASH',
        // itemA bán 200.000 và giá lấy theo danh mục, nên số tiền chính xác: không có dòng tiền thối, mọi chênh lệch bên dưới đều đúng +200.000.
        customerPay: 200_000,
        items: [{ productItemId: itemAId, quantity: 1 }],
      })
      .expect(201);

    const second = await http()
      .get(`/cash-drawer-sessions/${sessionId}/reconciliation`)
      .set(auth())
      .expect(200);
    expect(second.body.data.cashIn).toBe(report.cashIn + 200_000);
    expect(second.body.data.expectedClosing).toBe(
      report.expectedClosing + 200_000,
    );
    expect(second.body.data.countedClosing).toBe(report.countedClosing);
    expect(second.body.data.variance).toBe(report.variance - 200_000);
    // Đơn bán sau END cuối rơi vào đoạn đóng ca, lúc không ai giữ ngăn kéo - đúng dạng "tiền vào ngăn kéo sau khi đã đếm".
    expect(second.body.data.segments.at(-1)).toMatchObject({
      kind: 'CLOSING',
      cashIn: 200_000,
    });
    note(
      `a 200k cash sale moved expected ${report.expectedClosing} → ${second.body.data.expectedClosing} and variance ${report.variance} → ${second.body.data.variance} OK`,
    );

    const variance = second.body.data.variance;

    const range = await http()
      .get('/cash-drawer-sessions/reconciliation')
      .query({ branchId })
      .set(auth())
      .expect(200);
    const row = range.body.data.find((r: any) => r.sessionId === sessionId);
    expect(row).toBeDefined();
    expect(row.variance).toBe(variance);
    expect(row.expectedClosing).toBe(second.body.data.expectedClosing);
    expect(range.body.totals.sessions).toBe(range.body.pagination.total);
    note(
      `GET /reconciliation: ${range.body.totals.sessions} session(s), total variance ${range.body.totals.totalVariance} OK`,
    );

    // varianceOnly lọc trên toàn khoảng trước khi phân trang, nên giữ hay bỏ phiên này theo con số ở trên - không bao giờ theo trang.
    const off = await http()
      .get('/cash-drawer-sessions/reconciliation')
      .query({ branchId, varianceOnly: true })
      .set(auth())
      .expect(200);
    const stillListed = off.body.data.some(
      (r: any) => r.sessionId === sessionId,
    );
    expect(stillListed).toBe(variance !== 0);
    expect(
      off.body.data.every((r: any) => r.variance !== 0 && r.variance !== null),
    ).toBe(true);
    note(
      `varianceOnly=true kept ${off.body.data.length} unbalanced session(s) OK`,
    );

    await http()
      .get('/cash-drawer-sessions/reconciliation')
      .query({ branchId, fromDate: '2024-01-01', toDate: '2026-12-31' })
      .set(auth())
      .expect(400);
    note('a range longer than a year: 400 OK');
  });

  it('lets a branch open a new drawer once the previous one is closed', async () => {
    // Unique thường trên (tenant, branch, status) của schema cũ khiến việc này không thể từ ngày thứ hai - chi nhánh chỉ giữ được đúng một phiên CLOSED.
    const previous = await prisma.cashDrawerSession.findUnique({
      where: { id: sessionId },
      select: { businessDate: true },
    });
    // Chuyển phiên hôm qua khỏi ngày hôm nay để unique theo ngày không bị kích hoạt.
    await prisma.cashDrawerSession.update({
      where: { id: sessionId },
      data: { businessDate: new Date('2026-08-25T00:00:00.000Z') },
    });

    const reopened = await http()
      .post('/cash-drawer-sessions')
      .set(auth())
      .send({ branchId, staffId: secondStaffId, openingAmount: 500_000 })
      .expect(201);
    expect(reopened.body.data.status).toBe('OPEN');
    note(
      `a second session at the same branch after the first closed: OK (was impossible before the partial index; previous day ${previous!.businessDate.toISOString().slice(0, 10)})`,
    );

    const closedList = await http()
      .get('/cash-drawer-sessions?status=CLOSED')
      .set(auth())
      .expect(200);
    expect(closedList.body.pagination.total).toBe(1);
    expect(closedList.body.data[0].shiftLogCount).toBe(4);
    note(
      'GET /cash-drawer-sessions?status=CLOSED: summary carries shiftLogCount OK',
    );

    const current = await http()
      .get(`/cash-drawer-sessions/current?branchId=${branchId}`)
      .set(auth())
      .expect(200);
    expect(current.body.data.id).toBe(reopened.body.data.id);
    note('GET /cash-drawer-sessions/current returns the open one OK');
  });

  it('keeps a cashier to the sessions they actually worked', async () => {
    const staffLogin = await http()
      .post('/auth/login')
      .send({ phoneNumber: PHONE_STAFF, password: 'newpass123' })
      .expect(201);

    // Role chỉ có read_own, không có read - thu ngân 1 chỉ làm phiên đầu tiên.
    const mine = await http()
      .get('/cash-drawer-sessions')
      .set(auth(staffLogin.body.data.accessToken))
      .expect(200);
    expect(mine.body.pagination.total).toBe(1);
    expect(mine.body.data[0].id).toBe(sessionId);
    note(
      "read_own: cashier sees only the session they worked, not the branch's newest one OK",
    );

    const ownerView = await http()
      .get('/cash-drawer-sessions')
      .set(auth())
      .expect(200);
    expect(ownerView.body.pagination.total).toBe(2);
    note('owner sees both sessions OK');
  });

  it('rejects a duplicate shift log sent twice at once', async () => {
    // Guard phải tiến lên ngay cả khi phiên không đổi gì - START hoặc END không bàn giao chỉ ghi vào bảng log ca. Trước khi sửa, `updateMany` với `data` rỗng khớp dòng mà không chạm `updatedAt`, nên chạm đúp hoặc client retry tạo hai log giống hệt và thiếu hụt không còn truy được người chịu trách nhiệm.
    const opened = await prisma.cashDrawerSession.findFirstOrThrow({
      where: { tenantId, status: 'OPEN' },
      select: { id: true, currentStaffId: true },
    });

    const holder = await prisma.user.findUniqueOrThrow({
      where: { id: opened.currentStaffId },
      select: { phoneNumber: true },
    });
    const login = await http()
      .post('/auth/login')
      .send({
        phoneNumber: holder.phoneNumber,
        password:
          holder.phoneNumber === PHONE_STAFF ? 'newpass123' : 'password123',
      })
      .expect(201);
    const holderToken = login.body.data.accessToken;

    const submit = () =>
      http()
        .post(`/cash-drawer-sessions/${opened.id}/shift-logs`)
        .set(auth(holderToken))
        .send({ type: 'START', amount: 500_000 });

    const [a, b] = await Promise.all([submit(), submit()]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);

    const logs = await prisma.cashDrawerShiftLog.count({
      where: { sessionId: opened.id, type: 'START' },
    });
    expect(logs).toBe(1);
    note(
      `two identical START logs at once: ${statuses.join(' + ')}, exactly 1 log written OK`,
    );
  });

  it('refuses a staff account that belongs to no branch', async () => {
    // Thu ngân được cấp cash_drawers:read nhưng chưa được gán chi nhánh từng rơi vào "không lọc chi nhánh" và thấy mọi ngăn kéo trong tenant.
    await http()
      .patch(`/roles/${roleId}`)
      .set(auth())
      .send({
        permissions: [
          { resource: 'cash_drawers', action: 'read' },
          { resource: 'cash_drawers', action: 'report' },
        ],
      })
      .expect(200);

    const drifter = await http()
      .post('/users')
      .set(auth())
      .send({ phoneNumber: '0987650004', roleId, branchId })
      .expect(201);
    await http()
      .post(`/users/${drifter.body.data.id}/account`)
      .set(auth())
      .send({ newPassword: 'password123', reEnterPassword: 'password123' })
      .expect(201);

    // Gỡ phân công của họ.
    await prisma.user.update({
      where: { id: drifter.body.data.id },
      data: { locationId: null },
    });

    const login = await http()
      .post('/auth/login')
      .send({ phoneNumber: '0987650004', password: 'password123' })
      .expect(201);

    await http()
      .get('/cash-drawer-sessions')
      .set(auth(login.body.data.accessToken))
      .expect(403);
    note('unposted staff with cash_drawers:read listing tills: 403 OK');

    const anySession = await prisma.cashDrawerSession.findFirstOrThrow({
      where: { tenantId },
      select: { id: true },
    });
    await http()
      .get(`/cash-drawer-sessions/${anySession.id}`)
      .set(auth(login.body.data.accessToken))
      .expect(403);
    note('...and reading one by id: 403 OK');
  });

  it('refuses to discontinue a product that still has stock', async () => {
    const blocked = await http()
      .delete(`/products/${productId}`)
      .set(auth())
      .expect(400);
    expect(blocked.body.code).toBe('PRODUCT_HAS_STOCK');
    note('DELETE /products/:id with stock: 400 OK');
  });

  it('rosters shifts, merges slots and refuses overlaps', async () => {
    const template = await http()
      .post('/shift-templates')
      .set(auth())
      .send({ name: 'Ca sáng', startTime: '08:00', endTime: '12:00' })
      .expect(201);
    shiftTemplateId = template.body.data.id;
    // Cột `@db.Time` trả về Date; API giữ chuỗi HH:mm như cũ.
    expect(template.body.data.startTime).toBe('08:00');

    const night = await http()
      .post('/shift-templates')
      .set(auth())
      .send({ name: 'Ca đêm', startTime: '22:00', endTime: '06:00' })
      .expect(201);

    const rostered = await http()
      .post('/working-schedules/bulk')
      .set(auth())
      .send({
        schedules: [
          { userId: [staffId], shiftTemplateId, workDate: '2026-09-10' },
          // Cùng khung giờ, khác người - phải gộp thành một lịch, không phải hai.
          {
            userId: [secondStaffId],
            shiftTemplateId,
            workDate: '2026-09-10',
          },
        ],
      })
      .expect(201);
    expect(rostered.body.data).toHaveLength(1);
    expect(rostered.body.data[0].assignedUsers).toHaveLength(2);
    scheduleId = rostered.body.data[0].id;
    note(
      'bulk roster: two assignments on one slot merged into one schedule OK',
    );

    // 08:00 Việt Nam là 01:00 UTC - khoảng ca được dựng theo +07:00, không theo giờ server.
    expect(rostered.body.data[0].startAt).toContain('T01:00:00');

    // Ca đêm kết thúc vào ngày dương lịch kế tiếp.
    const nightRoster = await http()
      .post('/working-schedules/bulk')
      .set(auth())
      .send({
        schedules: [
          {
            userId: [staffId],
            shiftTemplateId: night.body.data.id,
            workDate: '2026-09-11',
          },
        ],
      })
      .expect(201);
    expect(nightRoster.body.data[0].endAt).toContain('2026-09-11T23:00');
    note('night shift 22:00–06:00 rolls endAt onto the next day OK');

    // Cùng người, khung giờ chồng lấn, ca khác → bị từ chối.
    const clash = await http()
      .post('/shift-templates')
      .set(auth())
      .send({ name: 'Ca chồng', startTime: '10:00', endTime: '14:00' })
      .expect(201);
    const overlap = await http()
      .post('/working-schedules/bulk')
      .set(auth())
      .send({
        schedules: [
          {
            userId: [staffId],
            shiftTemplateId: clash.body.data.id,
            workDate: '2026-09-10',
          },
        ],
      })
      .expect(409);
    expect(overlap.body.code).toBe('SCHEDULE_OVERLAP');
    note('overlapping shift for the same person: 409 OK');

    const listed = await http()
      .get('/working-schedules?startDate=2026-09-10&endDate=2026-09-10')
      .set(auth())
      .expect(200);
    expect(listed.body.pagination.total).toBe(1);
    // 2026-09-10 là thứ Năm và không phải ngày nghỉ.
    expect(listed.body.data[0].dayInfo.dayType).toBe('NORMAL');
    note('list: date range filter + dayInfo OK');

    await http()
      .delete(`/working-schedules/${scheduleId}/users/${secondStaffId}`)
      .set(auth())
      .expect(200);
    const afterRemoval = await http()
      .get(`/working-schedules/${scheduleId}`)
      .set(auth())
      .expect(200);
    expect(afterRemoval.body.data.assignedUsers).toHaveLength(1);
    note('remove one person from a shift OK');
  });

  it('grants shift-supervisor rights only while the shift is running', async () => {
    const staffLogin = await http()
      .post('/auth/login')
      .send({ phoneNumber: PHONE_STAFF, password: 'newpass123' })
      .expect(201);
    const staffToken = staffLogin.body.data.accessToken;

    // Role của họ lần cuối được đặt là [orders:read, cash_drawers:read_own, cash_drawers:report] - không có stock_movement nào, nên bị từ chối ngay.
    await http().get('/stock-movements').set(auth(staffToken)).expect(403);

    // Giao cho họ phụ trách một ca đang chạy ngay lúc này, tại chi nhánh của họ.
    const now = new Date();
    const live = await prisma.workingSchedule.create({
      data: {
        tenantId,
        managedById: staffId,
        shiftTemplateId,
        scheduleType: 'NORMAL',
        workDate: new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`),
        startAt: new Date(now.getTime() - 60 * 60 * 1000),
        endAt: new Date(now.getTime() + 60 * 60 * 1000),
        status: 'SCHEDULED',
        assignedUsers: { create: [{ userId: staffId }] },
      },
      select: { id: true },
    });

    // Cùng tài khoản, cùng token - quyền đến từ đồng hồ, không phải từ đăng nhập mới.
    const supervising = await http()
      .get('/stock-movements')
      .set(auth(staffToken))
      .expect(200);
    expect(supervising.body.success).toBe(true);
    note(
      'shift supervisor: stock_movement:read granted mid-shift on the same token OK',
    );

    // Đưa ca về quá khứ - quyền hết hạn theo đồng hồ, không có gì thu hồi nó.
    await prisma.workingSchedule.update({
      where: { id: live.id },
      data: {
        startAt: new Date(now.getTime() - 3 * 60 * 60 * 1000),
        endAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
      },
    });
    await http().get('/stock-movements').set(auth(staffToken)).expect(403);
    note('...and gone the moment the shift ends OK');

    await prisma.workingScheduleUser.deleteMany({
      where: { scheduleId: live.id },
    });
    await prisma.workingSchedule.delete({ where: { id: live.id } });
  });

  it('manages the public holiday calendar', async () => {
    const created = await http()
      .post('/holidays')
      .set(auth())
      .send({ date: '2026-09-02', name: 'Quốc khánh' })
      .expect(201);
    expect(created.body.data.source).toBe('MANUAL');
    // Mọi thứ người tạo đều được đánh dấu, nên đồng bộ Google sẽ không bao giờ đụng vào.
    expect(created.body.data.isManuallyEdited).toBe(true);
    const holidayId = created.body.data.id;

    // Khôi phục ràng buộc mà compound index Mongo từng thi hành: Postgres bỏ qua NULL branch_id trong @@unique thường, nên ràng buộc chỉ đứng vững nhờ migration partial-index.
    await http()
      .post('/holidays')
      .set(auth())
      .send({ date: '2026-09-02', name: 'Trùng ngày' })
      .expect(409);

    // Định dạng khớp regex nhưng ngày đó không tồn tại.
    await http()
      .post('/holidays')
      .set(auth())
      .send({ date: '2026-02-31', name: 'Không có thật' })
      .expect(400);

    // Tắt ngày nghỉ là một route riêng; PATCH từ chối trường này luôn.
    const rejected = await http()
      .patch(`/holidays/${holidayId}`)
      .set(auth())
      .send({ isActive: false })
      .expect(400);
    expect(rejected.body.message).toBeTruthy();

    const toggled = await http()
      .patch(`/holidays/${holidayId}/status`)
      .set(auth())
      .send({ isActive: false })
      .expect(200);
    expect(toggled.body.data.isActive).toBe(false);

    const listed = await http()
      .get('/holidays?year=2026&isActive=false')
      .set(auth())
      .expect(200);
    expect(listed.body.pagination.total).toBe(1);
    expect(listed.body.data[0].id).toBe(holidayId);

    // Năm khác không được khớp với nó.
    const other = await http()
      .get('/holidays?year=2025')
      .set(auth())
      .expect(200);
    expect(other.body.pagination.total).toBe(0);

    await http().delete(`/holidays/${holidayId}`).set(auth()).expect(200);
    await http()
      .patch(`/holidays/${holidayId}/status`)
      .set(auth())
      .send({ isActive: true })
      .expect(404);
    note(
      'holidays: create/duplicate 409/bad date 400/status route/year filter/delete OK',
    );
  });

  // Refresh token nằm trong Redis (docker compose up -d redis). Suite khẳng định toàn bộ vòng đời phiên mà hệ cũ có và lần port đầu làm mất: xoay vòng, chỉ dùng một lần, đăng xuất, và "đổi mật khẩu sẽ kết thúc mọi phiên khác".
  it('issues, rotates and revokes a refresh token', async () => {
    const login = await http()
      .post('/auth/login')
      .send({ phoneNumber: PHONE_OWNER, password: 'password123' })
      .expect(201);
    const first = login.body.data.refreshToken;
    expect(typeof first).toBe('string');

    const refreshed = await http()
      .post('/auth/refresh')
      .send({ refreshToken: first })
      .expect(200);
    expect(typeof refreshed.body.data.accessToken).toBe('string');
    const second = refreshed.body.data.refreshToken;
    expect(second).not.toBe(first);

    // Xoay vòng: token vừa dùng đã chết, nên replay (hoặc bản sao bị đánh cắp) sẽ thất bại.
    await http()
      .post('/auth/refresh')
      .send({ refreshToken: first })
      .expect(401);
    note('refresh: rotates and the spent token is refused (401) OK');

    // Access token mới thực sự dùng được.
    const me = await http()
      .get('/auth/me')
      .set(auth(refreshed.body.data.accessToken))
      .expect(200);
    expect(me.body.data.phoneNumber).toBe(PHONE_OWNER);

    await http()
      .post('/auth/logout')
      .set(auth(refreshed.body.data.accessToken))
      .send({ refreshToken: second })
      .expect(200);
    await http()
      .post('/auth/refresh')
      .send({ refreshToken: second })
      .expect(401);
    note('logout: session revoked, its refresh token no longer works OK');
  });

  it('ends every other session when the password changes', async () => {
    const a = await http()
      .post('/auth/login')
      .send({ phoneNumber: PHONE_OWNER, password: 'password123' })
      .expect(201);
    const b = await http()
      .post('/auth/login')
      .send({ phoneNumber: PHONE_OWNER, password: 'password123' })
      .expect(201);

    await http()
      .post('/auth/change-password')
      .set(auth(a.body.data.accessToken))
      .send({ currentPassword: 'password123', newPassword: 'password123' })
      .expect(201);

    // Cả hai phiên, không chỉ phiên kia: hệ cũ thu hồi theo userId.
    await http()
      .post('/auth/refresh')
      .send({ refreshToken: a.body.data.refreshToken })
      .expect(401);
    await http()
      .post('/auth/refresh')
      .send({ refreshToken: b.body.data.refreshToken })
      .expect(401);
    note('change-password: every refresh token for the user revoked OK');
  });

  it('runs the forgot-password flow end to end', async () => {
    await http()
      .post('/auth/send-forgot-password-otp')
      .send({ phoneNumber: PHONE_OWNER })
      .expect(200);

    // DEV_BYPASS là lối thoát cho dev mà otpService cũ có; ở đây NODE_ENV=test.
    const verified = await http()
      .post('/auth/verify-forgot-password-otp')
      .send({ phoneNumber: PHONE_OWNER, otpCode: 'DEV_BYPASS' })
      .expect(200);
    const resetToken = verified.body.data.resetToken;
    expect(typeof resetToken).toBe('string');

    await http()
      .post('/auth/reset-password')
      .send({ token: resetToken, newPassword: 'password123' })
      .expect(200);

    await http()
      .post('/auth/login')
      .send({ phoneNumber: PHONE_OWNER, password: 'password123' })
      .expect(201);

    // Access token không phải reset token, dù chữ ký hợp lệ đến đâu.
    const login = await http()
      .post('/auth/login')
      .send({ phoneNumber: PHONE_OWNER, password: 'password123' })
      .expect(201);
    await http()
      .post('/auth/reset-password')
      .send({ token: login.body.data.accessToken, newPassword: 'password123' })
      .expect(400);
    note(
      'forgot-password: otp → reset token → new password; access token refused OK',
    );
  });

  it('reports whether a phone number or shop name is taken', async () => {
    const taken = await http()
      .post('/auth/check-availability')
      .send({ phoneNumber: PHONE_OWNER, tenantName: TENANT_NAME })
      .expect(200);
    expect(taken.body.data).toEqual({
      phoneNumberTaken: true,
      tenantNameTaken: true,
    });

    const free = await http()
      .post('/auth/check-availability')
      .send({ phoneNumber: '0900000999', tenantName: 'Không tồn tại 26-08' })
      .expect(200);
    expect(free.body.data).toEqual({
      phoneNumberTaken: false,
      tenantNameTaken: false,
    });
    note('check-availability: both fields reported OK');
  });

  // Hồi quy: /tenants là tài nguyên nền tảng trên model không có tenantId riêng, và PermissionsGuard bỏ qua TENANT_OWNER - nên chỉ @Permissions thì mọi chủ shop đều đọc, sửa, xóa được tenant khác và đọc được webhook key SePay của họ. AdminOnlyGuard là thứ chặn việc đó.
  // Dashboard. Bốn câu trả lời trong số này là SQL viết tay (gom theo ngày địa phương, doanh thu theo dòng, định giá tồn kho), mà typecheck không kiểm được gì - nên mỗi cái được chạy trên Postgres thật và con số được đối chiếu với những gì các test trước trong file này thực sự bán.
  it('reports the shop dashboard off real sales', async () => {
    const overview = await http()
      .get('/stats/overview')
      .set(auth())
      .expect(200);
    expect(overview.body.data.revenue).toBeGreaterThan(0);
    expect(overview.body.data.orderCount).toBeGreaterThan(0);
    // aov = round(revenue / orderCount), tính lại ở đây thay vì tin tưởng.
    expect(overview.body.data.aov).toBe(
      Math.round(overview.body.data.revenue / overview.body.data.orderCount),
    );
    // Không bán gì trong 30 ngày trước lần chạy này, nên mọi thay đổi là "từ zero" - cố ý trả null thay vì 0 hay Infinity.
    expect(overview.body.data.changePct.revenue).toBeNull();
    note('GET /stats/overview: revenue, AOV, null change-from-zero OK');

    // Bucket phải là ngày địa phương của shop. Mọi thứ suite này tạo ra đều xảy ra ngay bây giờ, nên chỉ có đúng một bucket và đó là hôm nay ở TP.HCM.
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Ho_Chi_Minh',
    }).format(new Date());
    const series = await http()
      .get('/stats/revenue?groupBy=day')
      .set(auth())
      .expect(200);
    expect(series.body.data.groupBy).toBe('day');
    expect(
      series.body.data.series.map((p: { bucket: string }) => p.bucket),
    ).toContain(today);
    const dayTotal = series.body.data.series.reduce(
      (sum: number, p: { revenue: number }) => sum + p.revenue,
      0,
    );
    expect(dayTotal).toBe(overview.body.data.revenue);
    note('GET /stats/revenue: local-day buckets sum to the overview total OK');

    const monthly = await http()
      .get('/stats/revenue?groupBy=month')
      .set(auth())
      .expect(200);
    expect(monthly.body.data.series[0].bucket).toBe(today.slice(0, 7));

    const byMethod = await http()
      .get('/stats/revenue-by-payment-method')
      .set(auth())
      .expect(200);
    expect(byMethod.body.data.breakdown.length).toBeGreaterThan(0);
    // Sắp xếp theo doanh thu giảm dần, như stage $sort cũ.
    const revenues = byMethod.body.data.breakdown.map(
      (row: { revenue: number }) => row.revenue,
    );
    expect([...revenues].sort((a: number, b: number) => b - a)).toEqual(
      revenues,
    );

    const byStaff = await http()
      .get('/stats/revenue-by-staff')
      .set(auth())
      .expect(200);
    expect(byStaff.body.data.staff.length).toBeGreaterThan(0);
    expect(
      byStaff.body.data.staff.reduce(
        (sum: number, row: { revenue: number }) => sum + row.revenue,
        0,
      ),
    ).toBe(overview.body.data.revenue);
    note('revenue-by-payment-method / -by-staff: both re-total to overview OK');

    const top = await http()
      .get('/stats/top-products?sortBy=revenue&limit=5')
      .set(auth())
      .expect(200);
    expect(top.body.data.sortBy).toBe('revenue');
    expect(top.body.data.products.length).toBeGreaterThan(0);
    expect(top.body.data.products[0].productName).toEqual(expect.any(String));
    const topRevenues = top.body.data.products.map(
      (row: { revenue: number }) => row.revenue,
    );
    expect([...topRevenues].sort((a: number, b: number) => b - a)).toEqual(
      topRevenues,
    );
    note('GET /stats/top-products: line revenue summed and ranked in SQL OK');

    // Dòng tiền: góc nhìn sổ của cùng các đơn bán. `flow=ORD` tách chúng theo tiền tố reference.
    const cash = await http().get('/stats/cashflow').set(auth()).expect(200);
    expect(cash.body.data.income).toBeGreaterThan(0);
    expect(cash.body.data.expense).toBeGreaterThan(0);
    expect(cash.body.data.net).toBe(
      cash.body.data.income - cash.body.data.expense,
    );

    // ORD không phải "thu nhập" - đơn hoàn tiền ghi một khoản CHI có tiền tố ORD, nên luồng bán có cả hai phía.
    const salesOnly = await http()
      .get('/stats/cashflow?flow=ORD')
      .set(auth())
      .expect(200);
    expect(salesOnly.body.data.income).toBe(cash.body.data.income);
    expect(salesOnly.body.data.expense).toBeGreaterThan(0);
    // Mọi dòng tiền mặt suite này ghi đều là một đơn bán hoặc khoản hoàn của nó.
    expect(salesOnly.body.data.expense).toBe(cash.body.data.expense);
    note('GET /stats/cashflow: flow=ORD selects the sales ledger OK');

    const transactions = await http()
      .get('/stats/cashflow/transactions?page=1&limit=5')
      .set(auth())
      .expect(200);
    expect(transactions.body.data.length).toBeGreaterThan(0);
    expect(transactions.body.pagination.total).toBeGreaterThan(0);
    note('GET /stats/cashflow/transactions: paginated, names resolved OK');

    const inventory = await http()
      .get('/stats/inventory?lowStockThreshold=1000')
      .set(auth())
      .expect(200);
    expect(inventory.body.data.skuCount).toBeGreaterThan(0);
    expect(inventory.body.data.stockValue).toBeGreaterThan(0);
    expect(inventory.body.data.lowStock.length).toBeGreaterThan(0);
    // Địa điểm đa hình được tách thành hai cột nullable - đúng một cột được set.
    const row = inventory.body.data.lowStock[0];
    expect(Boolean(row.branchId) !== Boolean(row.warehouseId)).toBe(true);
    expect(row.locationType).toBe(row.branchId ? 'BRANCH' : 'WAREHOUSE');
    note('GET /stats/inventory: valuation joins cost price, low-stock list OK');
  });

  it('scopes the dashboard by posting, and keeps the platform view for admins', async () => {
    const staffLogin = await http()
      .post('/auth/login')
      .send({ phoneNumber: PHONE_STAFF, password: 'newpass123' })
      .expect(201);
    const staffToken = staffLogin.body.data.accessToken;

    // Không có reports:read thì guard chặn dashboard trước khi chạy bất kỳ bước phạm vi nào.
    await http().get('/stats/overview').set(auth(staffToken)).expect(403);

    await http()
      .patch(`/roles/${roleId}`)
      .set(auth())
      .send({ permissions: [{ resource: 'reports', action: 'read' }] })
      .expect(200);

    // Hệ cũ cho ai có reports:read xem mọi chi nhánh. Tài khoản được phân công giờ bị ghim vào địa điểm của mình; chọn địa điểm khác bị từ chối thay vì bỏ qua âm thầm - lỗi từng khiến quản lý đọc nhầm số chi nhánh khác thành số của mình.
    await http()
      .get(`/stats/overview?branchId=${branchId}`)
      .set(auth(staffToken))
      .expect(200);
    await http()
      .get('/stats/overview?branchId=00000000-0000-4000-8000-000000000000')
      .set(auth(staffToken))
      .expect(403);
    note('stats scoping: own branch 200, another branch 403 OK');

    await http().get('/stats/admin/overview').set(auth()).expect(403);

    const adminLogin = await http()
      .post('/auth/login')
      .send({ phoneNumber: PHONE_ADMIN, password: 'password123' })
      .expect(201);
    const platform = await http()
      .get('/stats/admin/overview?groupBy=month')
      .set(auth(adminLogin.body.data.accessToken))
      .expect(200);

    expect(platform.body.data.tenants.total).toBeGreaterThan(0);
    expect(platform.body.data.revenue.groupBy).toBe('month');
    // Trạng thái ticket gộp thành hai nhóm, không được rơi ra ngoài (RESOLVED dù không đạt được vẫn tính là đã xử lý, không phải trạng thái thiếu).
    expect(platform.body.data.tickets.total).toBe(
      platform.body.data.tickets.open + platform.body.data.tickets.resolved,
    );
    // Tenant này đã được đặt SePay key trước đó, nên ít nhất một shop đã liên kết.
    expect(platform.body.data.sepay.linked).toBeGreaterThan(0);
    expect(platform.body.data.subscriptions.byStatus.TRIAL).toBeGreaterThan(0);
    note('GET /stats/admin/overview: TENANT_OWNER 403, admin sees platform OK');
  });

  it('rejects a backwards or unparseable stats range', async () => {
    const backwards = await http()
      .get('/stats/overview?fromDate=2026-03-31&toDate=2026-03-01')
      .set(auth())
      .expect(400);
    expect(backwards.body.success).toBe(false);

    await http()
      .get('/stats/overview?fromDate=not-a-date')
      .set(auth())
      .expect(400);
    await http().get('/stats/revenue?groupBy=week').set(auth()).expect(400);
    await http().get('/stats/cashflow?flow=NOPE').set(auth()).expect(400);
    note('stats validation: backwards range, bad date, bad enum all 400 OK');
  });

  // Luồng hỗ trợ. Điểm chính của module là hội thoại hai chiều, nên test đi xuyên suốt một luồng thay vì thử từng route riêng: shop mở, operator trả lời, shop đáp lại, operator đóng, rồi mới tới lúc trả lời bị lỗi.
  it('runs a support ticket from open to closed across both consoles', async () => {
    const adminLogin = await http()
      .post('/auth/login')
      .send({ phoneNumber: PHONE_ADMIN, password: 'password123' })
      .expect(201);
    const adminToken = adminLogin.body.data.accessToken;

    const opened = await http()
      .post('/tickets')
      .set(auth())
      .send({
        title: 'Máy in hoá đơn không kết nối',
        description: 'Sau khi cập nhật, máy in ở quầy 1 không nhận lệnh in.',
        priority: 'HIGH',
      })
      .expect(201);
    const ticketId = opened.body.data.id;
    // Không dùng kiểu `TK-<epoch><2 digits>` cũ - dùng cùng bộ sinh như mọi mã tham chiếu khác.
    expect(opened.body.data.ticketId).toMatch(/^TK[0-9A-F]{10}$/);
    expect(opened.body.data.status).toBe('OPEN');
    // Mô tả cũng là tin nhắn mở đầu, nên luồng tự đủ thông tin.
    expect(opened.body.data.messages).toHaveLength(1);
    expect(opened.body.data.messages[0].message).toContain('máy in ở quầy 1');
    note('POST /tickets: TK reference, status OPEN, opening message OK');

    // Dòng inbox của operator là thông báo hệ thống - cả tenantId và recipientId đều null - không phải thông báo gửi tới ai đó trong shop.
    const systemRow = await prisma.notification.findFirst({
      where: { type: 'SYSTEM_TICKET_CREATED', referenceId: ticketId },
      select: { tenantId: true, recipientId: true },
    });
    expect(systemRow).toMatchObject({ tenantId: null, recipientId: null });
    note('ticket created: SYSTEM_TICKET_CREATED for the operators OK');

    const mine = await http().get('/tickets/my').set(auth()).expect(200);
    expect(mine.body.data).toHaveLength(1);
    expect(mine.body.data[0].id).toBe(ticketId);

    await http().get('/admin/tickets').set(auth()).expect(403);
    note('TENANT_OWNER on /admin/tickets: 403 OK');

    const inbox = await http()
      .get('/admin/tickets?page=1&limit=10')
      .set(auth(adminToken))
      .expect(200);
    expect(inbox.body.data.some((t: { id: string }) => t.id === ticketId)).toBe(
      true,
    );
    expect(inbox.body.pagination.total).toBeGreaterThan(0);

    const answered = await http()
      .post(`/admin/tickets/${ticketId}/reply`)
      .set(auth(adminToken))
      .send({ message: 'Bạn thử rút nguồn máy in và cắm lại giúp mình nhé.' })
      .expect(200);
    expect(answered.body.data.status).toBe('IN_PROGRESS');
    expect(answered.body.data.messages).toHaveLength(2);
    note('admin reply: status IN_PROGRESS, 2 messages OK');

    // Khác với sự kiện mở, câu trả lời phải tới inbox của chủ shop.
    const owned = await prisma.notification.count({
      where: { type: 'TICKET_REPLIED', referenceId: ticketId, tenantId },
    });
    expect(owned).toBeGreaterThan(0);
    note('admin reply: TICKET_REPLIED lands in the owner inbox OK');

    const back = await http()
      .post(`/tickets/${ticketId}/my-reply`)
      .set(auth())
      .send({ message: 'Vẫn không được ạ.' })
      .expect(200);
    // Quay lại OPEN - luồng cần operator trả lời lần nữa.
    expect(back.body.data.status).toBe('OPEN');
    expect(back.body.data.messages).toHaveLength(3);
    note('shop reply: status back to OPEN, 3 messages OK');

    const closed = await http()
      .patch(`/admin/tickets/${ticketId}/close`)
      .set(auth(adminToken))
      .expect(200);
    expect(closed.body.data.status).toBe('CLOSED');

    await http()
      .post(`/tickets/${ticketId}/my-reply`)
      .set(auth())
      .send({ message: 'Cho hỏi thêm' })
      .expect(400);
    note('reply to a CLOSED ticket: 400 OK');

    // Chỉ xóa mềm và một phía: biến mất khỏi danh sách của shop, vẫn còn trong danh sách của operator.
    const removed = await http()
      .delete(`/tickets/${ticketId}`)
      .set(auth())
      .expect(200);
    expect(removed.body.data.isDeletedByTenant).toBe(true);

    const afterDelete = await http().get('/tickets/my').set(auth()).expect(200);
    expect(afterDelete.body.data).toHaveLength(0);

    const adminStillSees = await http()
      .get('/admin/tickets?page=1&limit=50')
      .set(auth(adminToken))
      .expect(200);
    expect(
      adminStillSees.body.data.some((t: { id: string }) => t.id === ticketId),
    ).toBe(true);
    note(
      'DELETE /tickets/:id: hidden from the shop, kept for the operators OK',
    );
  });

  // Hội thoại AI. Không chạy `/ai/chat` ở đây - nó sẽ tốn quota Gemini thật mỗi lần chạy và lỗi bất cứ khi nào mạng hoặc tên model đổi; vòng lặp agent được phủ bởi ai-agent.service.spec.ts với model giả lập. Ở đây kiểm mọi thứ xung quanh: cổng quyền, phạm vi theo từng người và CRUD.
  it('keeps AI conversations private to the person who had them', async () => {
    const staffLogin = await http()
      .post('/auth/login')
      .send({ phoneNumber: PHONE_STAFF, password: 'newpass123' })
      .expect(201);
    const staffToken = staffLogin.body.data.accessToken;

    // Route cũ bị chặn theo hai role cố định đã không còn; giờ shop tự quyết ai được dùng trợ lý, qua tài nguyên ai_chat trong catalog.
    await http().get('/ai/conversations').set(auth(staffToken)).expect(403);
    await http()
      .post('/ai/chat')
      .set(auth(staffToken))
      .send({ message: 'doanh thu tháng này?' })
      .expect(403);
    note('ai: staff without ai_chat on /ai/chat and /ai/conversations 403 OK');

    // Seed trực tiếp: tạo qua /ai/chat sẽ gọi Gemini.
    const owner = await prisma.user.findFirst({
      where: { phoneNumber: PHONE_OWNER },
      select: { id: true },
    });
    const conversation = await prisma.aIChatHistory.create({
      data: {
        tenantId,
        userId: owner!.id,
        title: 'Doanh thu tháng 8',
        messages: [
          { role: 'user', parts: [{ text: 'doanh thu tháng này?' }] },
          { role: 'model', parts: [{ text: '12.000.000đ' }] },
        ],
      },
      select: { id: true },
    });

    const mine = await http().get('/ai/conversations').set(auth()).expect(200);
    expect(mine.body.pagination.total).toBe(1);
    // Danh sách chỉ có tiêu đề - nội dung được lấy từng hội thoại một.
    expect(mine.body.data[0]).not.toHaveProperty('messages');
    expect(mine.body.data[0].title).toBe('Doanh thu tháng 8');

    const detail = await http()
      .get(`/ai/conversations/${conversation.id}`)
      .set(auth())
      .expect(200);
    expect(detail.body.data.messages).toHaveLength(2);

    // Hội thoại thuộc về một người, không thuộc shop: cấp quyền cho tài khoản nhân viên thì họ vẫn không đọc được luồng của chủ shop.
    await http()
      .patch(`/roles/${roleId}`)
      .set(auth())
      .send({
        permissions: [
          { resource: 'ai_chat', action: 'read' },
          { resource: 'ai_chat', action: 'delete' },
        ],
      })
      .expect(200);

    const staffList = await http()
      .get('/ai/conversations')
      .set(auth(staffToken))
      .expect(200);
    expect(staffList.body.pagination.total).toBe(0);
    await http()
      .get(`/ai/conversations/${conversation.id}`)
      .set(auth(staffToken))
      .expect(404);
    await http()
      .delete(`/ai/conversations/${conversation.id}`)
      .set(auth(staffToken))
      .expect(404);
    note(
      "ai: a colleague with ai_chat:read cannot reach someone else's thread OK",
    );

    const renamed = await http()
      .put(`/ai/conversations/${conversation.id}`)
      .set(auth())
      .send({ title: 'Báo cáo tháng 8' })
      .expect(200);
    expect(renamed.body.data.title).toBe('Báo cáo tháng 8');

    await http()
      .put(`/ai/conversations/${conversation.id}`)
      .set(auth())
      .send({ title: '   ' })
      .expect(400);

    await http()
      .delete(`/ai/conversations/${conversation.id}`)
      .set(auth())
      .expect(200);
    const after = await http().get('/ai/conversations').set(auth()).expect(200);
    expect(after.body.pagination.total).toBe(0);
    note('ai: rename / delete own conversation, blank title 400 OK');
  });

  // Console của operator đọc cùng bảng với inbox của mọi shop, nên điều cần chứng minh là sự tách biệt: feed chỉ hiện các dòng không thuộc ai, còn các route acknowledge/delete không thể chạm tới thông báo riêng của shop qua id.
  it('gives operators a system feed that cannot touch a shop inbox', async () => {
    const adminLogin = await http()
      .post('/auth/login')
      .send({ phoneNumber: PHONE_ADMIN, password: 'password123' })
      .expect(201);
    const adminToken = adminLogin.body.data.accessToken;

    await http().get('/admin/system-notifications').set(auth()).expect(403);

    const feed = await http()
      .get('/admin/system-notifications?page=1&limit=50')
      .set(auth(adminToken))
      .expect(200);
    expect(feed.body.pagination.total).toBeGreaterThan(0);
    // Ticket mở trước đó đã đưa một dòng vào đây; thông báo riêng của shop không được nằm trong đó, và mọi dòng phải mang cặp null định nghĩa thông báo hệ thống.
    expect(
      feed.body.data.some(
        (row: { type: string }) => row.type === 'SYSTEM_TICKET_CREATED',
      ),
    ).toBe(true);
    for (const row of feed.body.data) {
      expect(row.tenantId).toBeNull();
      expect(row.recipientId).toBeNull();
    }
    note('GET /admin/system-notifications: paginated, null-pair rows only OK');

    // markAsRead cũ không có bộ lọc nào - đây là hồi quy nó để lại. Thông báo gửi tới chủ shop phải không thể truy cập từ đây.
    const shopRow = await prisma.notification.findFirst({
      where: { tenantId, type: 'TICKET_REPLIED' },
      select: { id: true },
    });
    await http()
      .patch(`/admin/system-notifications/${shopRow!.id}/read`)
      .set(auth(adminToken))
      .expect(404);
    await http()
      .delete(`/admin/system-notifications/${shopRow!.id}`)
      .set(auth(adminToken))
      .expect(404);
    const untouched = await prisma.notification.findUnique({
      where: { id: shopRow!.id },
      select: { isRead: true },
    });
    expect(untouched!.isRead).toBe(false);
    note("admin cannot mark-read or delete a shop's own notification: 404 OK");

    const target = feed.body.data.find(
      (row: { type: string }) => row.type === 'SYSTEM_TICKET_CREATED',
    );
    const read = await http()
      .patch(`/admin/system-notifications/${target.id}/read`)
      .set(auth(adminToken))
      .expect(200);
    expect(read.body.data.isRead).toBe(true);

    const all = await http()
      .patch('/admin/system-notifications/mark-all-read')
      .set(auth(adminToken))
      .expect(200);
    expect(all.body.success).toBe(true);
    note('mark-read / mark-all-read on the system feed OK');

    // Thông báo chung không phải sự kiện hệ thống: nó được ghi ở đây nhưng không bao giờ hiện trong feed phía trên.
    const announced = await http()
      .post('/admin/notifications')
      .set(auth(adminToken))
      .send({
        title: 'Bảo trì hệ thống 02:00 ngày mai',
        description: 'Hệ thống sẽ tạm ngưng khoảng 15 phút để nâng cấp.',
        category: 'Maintenance',
        targetType: 'SELECTION',
        targetTenants: [tenantId],
      })
      .expect(201);
    expect(announced.body.message).toContain('chủ cửa hàng');
    expect(announced.body.data.targetTenants).toHaveLength(1);

    const outbox = await http()
      .get('/admin/notifications')
      .set(auth(adminToken))
      .expect(200);
    expect(outbox.body.pagination.total).toBe(1);
    expect(outbox.body.data[0].targetType).toBe('SELECTION');

    const feedAfter = await http()
      .get('/admin/system-notifications?page=1&limit=50')
      .set(auth(adminToken))
      .expect(200);
    expect(
      feedAfter.body.data.some(
        (row: { type: string }) => row.type === 'ANNOUNCEMENT',
      ),
    ).toBe(false);
    note('announcement: saved to the outbox, absent from the event feed OK');

    // targetType=SELECTION với tenant không phải uuid trả 400, không gửi âm thầm cho không ai.
    await http()
      .post('/admin/notifications')
      .set(auth(adminToken))
      .send({
        title: 'x',
        description: 'y',
        category: 'Security',
        targetType: 'SELECTION',
        targetTenants: ['not-a-uuid'],
      })
      .expect(400);
  });

  it('keeps a tenant owner out of the platform-level /tenants routes', async () => {
    const forbidden = await http().get('/tenants').set(auth()).expect(403);
    expect(forbidden.body.success).toBe(false);

    await http().get(`/tenants/${tenantId}`).set(auth()).expect(403);
    await http()
      .patch(`/tenants/${tenantId}`)
      .set(auth())
      .send({ name: 'hijacked' })
      .expect(403);
    await http().delete(`/tenants/${tenantId}`).set(auth()).expect(403);
    note('TENANT_OWNER on /tenants (list/read/update/delete): 403 OK');
  });

  // Hồi quy: envelope của response. Nửa thành công đã được chứng minh bởi mọi assertion phía trên đọc `body.data`; test này ghim hai dạng không phải entity - danh sách phân trang được gộp thay vì lồng, và lỗi trả về `success: false`.
  it('answers in the { success, message?, data } envelope', async () => {
    const list = await http()
      .get('/products?page=1&limit=5')
      .set(auth())
      .expect(200);
    expect(list.body.success).toBe(true);
    expect(Array.isArray(list.body.data)).toBe(true);
    expect(list.body.pagination.total).toBeGreaterThan(0);

    const missing = await http()
      .get('/products/00000000-0000-4000-8000-000000000000')
      .set(auth())
      .expect(404);
    expect(missing.body).toMatchObject({
      success: false,
      statusCode: 404,
      message: expect.any(String),
    });

    // Lỗi ValidationPipe giữ danh sách theo từng trường trong `errors`, không đặt vào `message` hiển thị cho người dùng - dạng mà DTO validator cũ gửi.
    const invalid = await http()
      .post('/suppliers')
      .set(auth())
      .send({ supplierName: '' })
      .expect(400);
    expect(invalid.body.success).toBe(false);
    expect(Array.isArray(invalid.body.errors)).toBe(true);

    // Webhook SePay là @RawResponse() - body thuộc về SePay, không thuộc về ta.
    const webhook = await http()
      .post('/webhook/sepay/order')
      .send({ transferType: 'in' })
      .expect(200);
    expect(webhook.body).toEqual({
      success: false,
      message: 'Unknown API key or account',
    });
    note(
      'envelope: list merges, errors carry success:false, webhook stays raw OK',
    );
  });
});
