import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import * as bcrypt from 'bcryptjs';
import type { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AllExceptionsFilter } from './../src/common/filters/all-exceptions.filter';
import { PrismaService } from './../src/prisma/prisma.service';

/**
 * Throwaway smoke run over everything ported on 2026-08-25 - products, inventory, staff
 * and stock movements - against a real Postgres. Creates one tenant, exercises the routes,
 * and deletes everything it made.
 */
jest.setTimeout(120_000);

const PHONE_OWNER = '0987650001';
const PHONE_STAFF = '0987650002';
// A throwaway platform admin (tenantId null), for the routes only an operator may reach.
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
  let leaveRequestId = '';
  let paysheetId = '';
  let payrollPeriodId = '';

  const auth = (token = ownerToken) => ({ Authorization: `Bearer ${token}` });
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
    await prisma.payslipLeaveLineDate.deleteMany({
      where: { leaveLine: { payslip: { tenantId: t } } },
    });
    await prisma.payslipLeaveLine.deleteMany({
      where: { payslip: { tenantId: t } },
    });
    await prisma.payslipAllowanceLine.deleteMany({
      where: { payslip: { tenantId: t } },
    });
    await prisma.payslipBonusLine.deleteMany({
      where: { payslip: { tenantId: t } },
    });
    await prisma.payslipDeductionLine.deleteMany({
      where: { payslip: { tenantId: t } },
    });
    await prisma.payslipManualAdjustment.deleteMany({
      where: { payslip: { tenantId: t } },
    });
    await prisma.payslip.deleteMany({ where: { tenantId: t } });
    await prisma.payrollPeriod.updateMany({
      where: { tenantId: t },
      data: { cashFlowId: null },
    });
    await prisma.cashFlow.deleteMany({ where: { tenantId: t } });
    await prisma.payrollPeriod.deleteMany({ where: { tenantId: t } });
    await prisma.user.updateMany({
      where: { tenantId: t },
      data: { paysheetId: null },
    });
    await prisma.paysheetBonusTier.deleteMany({
      where: { bonus: { paysheet: { tenantId: t } } },
    });
    await prisma.paysheetBonus.deleteMany({
      where: { paysheet: { tenantId: t } },
    });
    await prisma.paysheetAllowance.deleteMany({
      where: { paysheet: { tenantId: t } },
    });
    await prisma.paysheetDeduction.deleteMany({
      where: { paysheet: { tenantId: t } },
    });
    await prisma.paysheet.deleteMany({ where: { tenantId: t } });
    await prisma.payrollSetting.deleteMany({ where: { tenantId: t } });
    await prisma.leaveRequestHandoverSchedule.deleteMany({
      where: { leaveRequest: { tenantId: t } },
    });
    await prisma.leaveRequest.deleteMany({ where: { tenantId: t } });
    await prisma.attendance.deleteMany({ where: { tenantId: t } });
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
    // Announcements have tenantId null but reach this tenant through the join table, whose
    // rows hold an FK to it - so they have to go before the tenant does. The delete cascades
    // to NotificationTargetTenant.
    await prisma.notification.deleteMany({
      where: { type: 'ANNOUNCEMENT', targetTenants: { some: { tenantId: t } } },
    });
    await prisma.auditLog.deleteMany({ where: { tenantId: t } });
    await prisma.subscriptionHistoryLog.deleteMany({
      where: { subscription: { tenantId: t } },
    });
    await prisma.subscriptionInvoice.deleteMany({ where: { tenantId: t } });
    await prisma.subscription.deleteMany({ where: { tenantId: t } });
    await prisma.branch.updateMany({
      where: { tenantId: t },
      data: { managerId: null },
    });
    await prisma.warehouse.updateMany({
      where: { tenantId: t },
      data: { managerId: null },
    });
    await prisma.rolePermission.deleteMany({
      where: { role: { tenantId: t } },
    });
    await prisma.userFcmToken.deleteMany({ where: { user: { tenantId: t } } });
    await prisma.user.updateMany({
      where: { tenantId: t },
      data: { roleId: null, branchId: null, warehouseId: null },
    });
    await prisma.role.deleteMany({ where: { tenantId: t } });
    await prisma.user.deleteMany({ where: { tenantId: t } });
    await prisma.branch.deleteMany({ where: { tenantId: t } });
    await prisma.warehouse.deleteMany({ where: { tenantId: t } });
    await prisma.tenant.deleteMany({ where: { id: t } });
    // Lives outside the tenant (tenantId null), so the sweep above never reaches it.
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
    note('branch + warehouse: OK');

    const supplier = await http()
      .post('/suppliers')
      .set(auth())
      .send({ supplierName: 'NCC Alpha', creditLimit: 10_000_000 })
      .expect(201);
    supplierId = supplier.body.data.id;
    note(`supplier: OK creditLimit=${supplier.body.data.creditLimit}`);
  });

  it('creates a product with variants and opening stock, in one transaction', async () => {
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
            initialStock: [
              { locationId: warehouseId, locationType: 'warehouse', stock: 50 },
              { locationId: branchId, locationType: 'branch', stock: 8 },
            ],
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

    expect(created.body.data.totalStock).toBe(58);
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
  });

  it('lists, searches and reads back products', async () => {
    const list = await http().get('/products').set(auth()).expect(200);
    expect(list.body.data[0].totalStock).toBe(58);
    note(
      `GET /products: OK total=${list.body.pagination.total} totalStock=${list.body.data[0].totalStock}`,
    );

    const scoped = await http()
      .get(`/products?locationId=${branchId}&locationType=branch`)
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

    await http()
      .get('/products?locationId=' + branchId)
      .set(auth())
      .expect(400);
    note('locationId without locationType: 400 OK');
  });

  it('runs the inventory routes, including the low-stock filter', async () => {
    const all = await http().get('/inventory').set(auth()).expect(200);
    expect(all.body.pagination.total).toBe(2);
    expect(all.body.data[0].location).toBeTruthy();
    note(
      `GET /inventory: ${all.body.pagination.total} rows, location object OK`,
    );

    const branchRow = all.body.data.find(
      (r: any) => r.location.locationType === 'branch',
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
        locationType: 'branch',
        productItemId: itemBId,
      })
      .expect(201);
    await http()
      .post('/inventory')
      .set(auth())
      .send({
        locationId: branchId,
        locationType: 'branch',
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

    // Hiring and granting access are two calls, as in the old system: POST /users puts the
    // person on the books with no password, POST /users/:id/account switches the login on.
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
    // No password on file means no way in, even with the right phone number.
    await http()
      .post('/auth/login')
      .send({ phoneNumber: PHONE_STAFF, password: 'password123' })
      .expect(401);

    // A password field on POST /users is silently stripped by the ValidationPipe's
    // whitelist rather than quietly setting one - pinned so the split can't regress.
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

    // Seats are billable, so hiring is capped by the plan the same way branches and
    // products are. Pinned to the staff already on the books, then released - the rest of
    // this suite hires two more.
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

    // Email is unique per shop, and it is checked when hiring - not only when editing,
    // which is where a duplicate used to lie undetected until someone opened the record.
    await http()
      .patch(`/users/${staffId}`)
      .set(auth())
      .send({ email: 'An.Tran@Example.com' })
      .expect(200);
    const dupEmail = await http()
      .post('/users')
      .set(auth())
      // Different case on purpose: @NormalizeEmail lowercases before anything compares.
      .send({
        phoneNumber: '0987650008',
        email: 'an.tran@example.com',
        roleId,
        branchId,
      })
      .expect(409);
    expect(dupEmail.body.message).toContain('Email');
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
    expect(updated.body.data.profileIdentificationId).toBe('079195001234');
    note('PATCH /users/:id profile + posting swap (branch cleared): OK');

    const balance = await http()
      .patch(`/users/${staffId}/leave-balance`)
      .set(auth())
      .send({ annualLeaveDays: 15 })
      .expect(200);
    expect(balance.body.message).toBeTruthy();
    expect(balance.body.data).toBeTruthy();
    expect(balance.body.leaveBalance.remainingDays).toBe(15);
    note('PATCH leave-balance → {message,data,leaveBalance} OK');

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

    // Put them back on the branch for the stock-movement scenario below.
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
        fromLocation: { locationId: warehouseId, locationType: 'warehouse' },
        toLocation: { locationId: branchId, locationType: 'branch' },
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
      where: { tenantId, warehouseId, productItemId: itemAId },
      select: { stock: true },
    });
    expect(afterShip?.stock).toBe(30);
    note(`ship: warehouse 50 → ${afterShip?.stock} OK`);

    // Short delivery: 18 of 20 arrive.
    await http()
      .patch(`/stock-movements/${id}/receive`)
      .set(auth())
      .send({ details: [{ productItemId: itemAId, receivedQuantity: 18 }] })
      .expect(200);

    const atBranch = await prisma.inventory.findFirst({
      where: { tenantId, branchId, productItemId: itemAId },
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
        fromLocation: { locationId: warehouseId, locationType: 'warehouse' },
        toLocation: { locationId: branchId, locationType: 'branch' },
        details: [{ productItemId: itemAId, quantity: 5 }],
      })
      .expect(201);
    const id = created.body.data.id;

    await http().patch(`/stock-movements/${id}/open`).set(auth()).expect(200);
    await http().patch(`/stock-movements/${id}/close`).set(auth()).expect(200);
    await http().patch(`/stock-movements/${id}/ship`).set(auth()).expect(200);
    await http().patch(`/stock-movements/${id}/cancel`).set(auth()).expect(200);

    const back = await prisma.inventory.findFirst({
      where: { tenantId, warehouseId, productItemId: itemAId },
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
        fromLocation: { locationId: warehouseId, locationType: 'warehouse' },
        toLocation: { locationId: branchId, locationType: 'branch' },
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
        toLocation: { locationId: warehouseId, locationType: 'warehouse' },
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
        toLocation: { locationId: warehouseId, locationType: 'warehouse' },
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
        toLocation: { locationId: warehouseId, locationType: 'warehouse' },
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
      where: { tenantId, warehouseId, productItemId: itemBId },
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

    // Nothing is sent here, and that is correct: the only recipient would be the tenant
    // owner, who is the person who just received the goods. iKiotMS-BE filtered the actor
    // out the same way. The warning firing for real is covered by the next test.
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

    // Move the staff member to the warehouse so they may receive there.
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
        toLocation: { locationId: warehouseId, locationType: 'warehouse' },
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

    // Edge-triggered: a second receipt above the line must stay quiet.
    const again = await http()
      .post('/stock-movements')
      .set(auth())
      .send({
        movementType: 'IMPORT',
        fromSupplierId: supplierB.body.data.id,
        toLocation: { locationId: warehouseId, locationType: 'warehouse' },
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
        fromLocation: { locationId: branchId, locationType: 'branch' },
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
      where: { tenantId, branchId, productItemId: itemAId },
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

    await http()
      .post('/stock-movements')
      .set(auth(staffToken))
      .send({
        movementType: 'EXPORT',
        fromLocation: { locationId: warehouseId, locationType: 'warehouse' },
        toLocation: { locationId: branchId, locationType: 'branch' },
        details: [{ productItemId: itemAId, quantity: 1 }],
      })
      .expect(403);
    note('staff creating a movement out of another location: 403 OK');

    await http().get('/products').set(auth(staffToken)).expect(403);
    note('staff without products:read on /products: 403 OK');
  });

  it('rings up a cash sale, computing the total server-side', async () => {
    const before = await prisma.inventory.findFirst({
      where: { tenantId, branchId, productItemId: itemAId },
      select: { stock: true },
    });

    const sale = await http()
      .post('/orders')
      .set(auth())
      .send({
        branchId,
        paymentMethod: 'CASH',
        customerPay: 500_000,
        // grandTotal is deliberately NOT sent - and would be ignored if it were.
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
      where: { tenantId, branchId, productItemId: itemAId },
      select: { stock: true },
    });
    expect(after!.stock).toBe(before!.stock - 2);
    note(`sale decremented branch stock ${before!.stock} → ${after!.stock} OK`);

    // Cash with change is two rows: the drawer took the note and gave some back.
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
    // itemA's retailPrice is 200.000. The request says 1đ. Until 2026-09-06 the server
    // believed it: `priceLines` selected only id/sku/productName and passed the client's
    // `unitPrice` straight through, so a basket could be rung up for nothing while stock
    // left the shelf and the ledger recorded an honest-looking sale.
    await prisma.inventory.updateMany({
      where: { tenantId, branchId, productItemId: itemAId },
      data: { stock: { increment: 2 } },
    });

    const sale = await http()
      .post('/orders')
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

    // The manual whole-order discount is capped at what the order is worth. `Math.max(0,…)`
    // alone only stopped the total going negative - any basket could still be settled at 0.
    await prisma.inventory.updateMany({
      where: { tenantId, branchId, productItemId: itemAId },
      data: { stock: { increment: 1 } },
    });
    const capped = await http()
      .post('/orders')
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
    // The hole this closes: the engine allocated per `productItemId` and the order read it
    // back per LINE, so N lines of one variant each received the sum of their shares. A
    // 10% promotion split across ten identical lines discounted 100% and the order was
    // written at 0đ - while ten units left the shelf.
    await prisma.inventory.updateMany({
      where: { tenantId, branchId, productItemId: itemAId },
      data: { stock: { increment: 10 } },
    });

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

    // Ten separate lines, same variant - exactly what a till does when it rings items in
    // one at a time.
    const sale = await http()
      .post('/orders')
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
      .post('/orders')
      .set(auth())
      .send({
        branchId,
        paymentMethod: 'CASH',
        items: [{ productItemId: itemAId, quantity: 9999 }],
      })
      .expect(400);
    note('POST /orders beyond branch stock: 400 OK');

    await http()
      .post('/orders')
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
      where: { tenantId, branchId, productItemId: itemAId },
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
      where: { tenantId, branchId, productItemId: itemAId },
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
      .post('/orders')
      .set(auth())
      .send({
        branchId,
        paymentMethod: 'SEPAY',
        items: [{ productItemId: itemAId, quantity: 1 }],
      })
      .expect(400);
    note('SEPAY sale without tenant banking configured: 400 OK');

    // Through the real endpoint, not a direct write. Until `/tenant/banking` was ported
    // there was no way for a shop to configure this, which made SEPAY sales unreachable
    // outside a manual UPDATE - the seed here used to be that workaround.
    const banked = await http()
      .put('/tenant/banking')
      .set(auth())
      .send({
        bankName: 'MB',
        accountNumber: '0000000000',
        accountName: 'SMOKE TEST',
      })
      .expect(200);
    expect(banked.body.data.bankingBankName).toBe('MB');
    // The secret is never in a response, even to the shop that owns it.
    expect(banked.body.data.bankingSepayWebhookApiKey).toBeUndefined();

    const mine = await http().get('/tenant/me').set(auth()).expect(200);
    expect(mine.body.data.bankingAccountNumber).toBe('0000000000');
    expect(mine.body.data.hasSepayKey).toBe(false);
    expect(mine.body.data.bankingSepayWebhookApiKey).toBeUndefined();
    note('PUT /tenant/banking + GET /tenant/me: saved, secret withheld OK');

    // The operators get told there is an account to link - the first half of the manual
    // SePay workflow, and a system notification (no tenant, no recipient).
    const heads = await prisma.notification.findFirst({
      where: { type: 'SYSTEM_TENANT_BANK_UPDATED', tenantId: null },
      orderBy: { createdAt: 'desc' },
    });
    expect(heads?.description).toContain('MB');
    note('bank update raises a SYSTEM_TENANT_BANK_UPDATED notification OK');

    const sale = await http()
      .post('/orders')
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
    note('pay-offline: SEPAY order settled as CASH, COMPLETED OK');

    await http()
      .post(`/orders/${sale.body.data.order.id}/pay-offline`)
      .set(auth())
      .send({ paymentMethod: 'CASH' })
      .expect(409);
    note('pay-offline twice: 409 OK (cannot double-charge)');
  });

  it('settles a SePay sale from the webhook', async () => {
    // Provisioning the webhook key is a platform-admin job, through the real route. The
    // old system's route claimed SUPER_ADMIN in a comment but enforced nothing, so any
    // account with `tenants:update` could write any shop's key - the thing that identifies
    // a tenant to the payment webhook. Both halves are asserted here.
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
      .post('/orders')
      .set(auth())
      .send({
        branchId,
        paymentMethod: 'SEPAY',
        items: [{ productItemId: itemAId, quantity: 1 }],
      })
      .expect(201);
    const reference = sale.body.data.order.paymentReference;

    // Unknown key: answered 200 so SePay stops, but nothing is settled.
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
    // The only key tying this order to a line on the bank statement. Dropped by the first
    // port, restored 2026-08-26 - kept on the cash flow too, since that is what a
    // reconciliation actually reads.
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

    // The till names the promotion and nothing else - no breakdown, no discountValue, no
    // discountType. Everything the old contract asked the client to echo back is worked
    // out server-side now, so this is the regression test for an order that would
    // previously have been rung up at full price with a discount showing on screen.
    const withDiscount = await http()
      .post('/orders')
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

    // Sending the old payload shape must land on the same numbers: the extra keys are
    // stripped by ValidationPipe and the client-supplied amounts are simply not read.
    const legacyShape = await http()
      .post('/orders')
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

    // A manual whole-order discount and a promotion have one column between them.
    const conflict = await http()
      .post('/orders')
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

    // usageLimit was 1 and the previous test consumed it, so it is no longer eligible.
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
      .post('/orders')
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
    // The FK would accept it - it is a real promotion id, just not this tenant's.
    const outsider = await prisma.promotion.findFirst({
      where: { tenantId: { not: tenantId } },
      select: { id: true },
    });

    // 400, not the 404 this used to answer: the order no longer looks the promotion up
    // itself, it prices the cart through the engine, and an id that isn't among this
    // tenant's live candidates comes back as "gone or not applicable to this order" -
    // one message for both, which is also the right answer for a cross-tenant id.
    const refused = await http()
      .post('/orders')
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

  // The engine re-checks eligibility now, so an order can no longer claim a promotion the
  // preview would have refused. The old code only checked the id existed in the tenant.
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
      .post('/orders')
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
    // The frontend cannot gate a screen on an account *kind* any more - a shop defines its
    // own roles - so `/auth/me` hands back the set `JwtStrategy` resolved for this very
    // request, and the UI draws from that.
    await http()
      .patch(`/roles/${roleId}`)
      .set(auth())
      .send({
        permissions: [
          { resource: 'products', action: 'read' },
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

    expect(staffMe.body.data.permissions.sort()).toEqual([
      'orders:read',
      'products:read',
    ]);
    expect(staffMe.body.data.systemRole).toBe('STAFF');
    note('GET /auth/me (staff): trả đúng 2 quyền của vai trò OK');

    // Empty for the owner, and that means "not applicable" - they short-circuit the guard
    // entirely. A client reading it as "no permissions" would lock the owner out of their
    // own shop, which is exactly what happened before this was documented.
    const ownerMe = await http().get('/auth/me').set(auth()).expect(200);
    expect(ownerMe.body.data.permissions).toEqual([]);
    expect(ownerMe.body.data.systemRole).toBe('TENANT_OWNER');
    note('GET /auth/me (chủ shop): permissions rỗng = "không áp dụng" OK');

    // Revoking one takes effect on the next request, no re-login.
    await http()
      .patch(`/roles/${roleId}`)
      .set(auth())
      .send({ permissions: [{ resource: 'orders', action: 'read' }] })
      .expect(200);
    const after = await http()
      .get('/auth/me')
      .set(auth(staffLogin.body.data.accessToken))
      .expect(200);
    expect(after.body.data.permissions).toEqual(['orders:read']);
    note('thu hồi quyền: /auth/me phản ánh ngay trên token cũ OK');
  });

  it('scopes order reads to the branch a staff account works at', async () => {
    const login = await http()
      .post('/auth/login')
      .send({ phoneNumber: PHONE_STAFF, password: 'newpass123' })
      .expect(201);
    const staffToken = login.body.data.accessToken;

    // The staff role has no orders:* yet - grant read only, no view_all.
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

    // A query filter may narrow the scope, never replace it. Until 2026-09-06 this read
    // `if (query.branchId) where.branchId = query.branchId`, so naming another branch
    // handed back its whole sales ledger - while `GET /orders/:id` refused the same rows.
    // Reuse the second branch an earlier test created - the TRIAL plan caps a shop at two,
    // so creating a third here would be refused by the quota, not by the scope rule.
    const otherBranch = await prisma.branch.findFirstOrThrow({
      where: { tenantId, id: { not: branchId }, status: 'ACTIVE' },
      select: { id: true },
    });

    await http()
      .get('/orders')
      .query({ branchId: otherBranch.id })
      .set(auth(staffToken))
      .expect(403);
    note('staff GET /orders?branchId=<chi nhánh khác>: 403 OK');

    // Echoing back your own branch is normal - a screen sends what it was showing.
    await http()
      .get('/orders')
      .query({ branchId })
      .set(auth(staffToken))
      .expect(200);

    // The owner is unscoped, so naming a branch still narrows for them.
    await http()
      .get('/orders')
      .query({ branchId: otherBranch.id })
      .set(auth())
      .expect(200);
    note('owner vẫn lọc được theo chi nhánh bất kỳ OK');

    // Same rule, other modules: `?userId=` used to replace "me" with anybody.
    await http()
      .get('/attendances/me')
      .query({ userId: secondStaffId })
      .set(auth(staffToken))
      .expect(403);
    await http()
      .get('/leave-requests/me')
      .query({ userId: secondStaffId })
      .set(auth(staffToken))
      .expect(403);
    note(
      '/attendances/me và /leave-requests/me với ?userId= người khác: 403 OK',
    );
  });

  it('refuses to sell more than the shelf holds, from inside the write', async () => {
    const line = await prisma.inventory.findFirst({
      where: { tenantId, branchId, productItemId: itemAId },
      select: { stock: true },
    });

    await http()
      .post('/orders')
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
      where: { tenantId, branchId, productItemId: itemAId },
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
        .post('/orders')
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
    // Staff needs the till permissions for this scenario.
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

    // A second cashier to hand over to - hired, then given a login.
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

    // Only whoever holds the drawer may write to it.
    await http()
      .post(`/cash-drawer-sessions/${sessionId}/shift-logs`)
      .set(auth(secondToken))
      .send({ type: 'START', amount: 2_000_000 })
      .expect(404);
    note('a cashier who never held the drawer cannot even see it: 404 OK');

    // END before START is out of sequence.
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

    // Finalizing mid-shift is refused - the last log is a START.
    await http()
      .post(`/cash-drawer-sessions/${sessionId}/finalize`)
      .set(auth())
      .send({ finalAmount: 2_500_000 })
      .expect(409);
    note('finalize with a shift still open: 409 OK');

    // Hand over to the second cashier.
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

    // The first cashier no longer holds it.
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
    // The gap this closes: the session recorded what people *counted* and CashFlow recorded
    // what *moved*, and nothing ever subtracted one from the other.
    const session = await prisma.cashDrawerSession.findUniqueOrThrow({
      where: { id: sessionId },
      select: { businessDate: true, openingAmount: true, finalLogAmount: true },
    });

    const first = await http()
      .get(`/cash-drawer-sessions/${sessionId}/reconciliation`)
      .set(auth())
      .expect(200);
    const report = first.body.data;

    // The trading-day window, checked against the +07:00 offset directly rather than
    // against the helper that produced it - an hour out here moves every pre-07:00 receipt
    // onto the previous day's till, which is the failure this whole feature exists to find.
    const dayStart = new Date(
      session.businessDate.getTime() - 7 * 60 * 60 * 1000,
    );
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
    expect(new Date(report.window.start).getTime()).toBe(dayStart.getTime());
    expect(new Date(report.window.end).getTime()).toBe(dayEnd.getTime());

    // Read the ledger independently and check the endpoint agrees with it.
    const flows = await prisma.cashFlow.findMany({
      where: {
        tenantId,
        branchId,
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

    // Four shift logs (START, END+handover, START, END) split the day into five stretches,
    // and the zero-length GAP between the handover and the next START is one of them.
    expect(report.segments.map((s: any) => s.kind)).toEqual([
      'OPENING',
      'SHIFT',
      'GAP',
      'SHIFT',
      'CLOSING',
    ]);
    expect(report.segments[1].staff.id).toBe(staffId);
    expect(report.segments[3].staff.id).toBe(secondStaffId);

    // The property the report rests on: the day is short by X and the segments say where.
    const summed = report.segments.reduce(
      (total: number, segment: any) => total + (segment.variance ?? 0),
      0,
    );
    expect(summed).toBe(report.variance);
    note(
      `segments ${report.segments.map((s: any) => `${s.kind}:${s.variance}`).join(' ')} sum to the session variance OK`,
    );

    // Non-cash never enters the drawer, so it is reported beside the variance, not in it.
    expect(
      report.nonCash.every((row: any) => row.paymentMethod !== 'CASH'),
    ).toBe(true);

    // Now move real money and check the report follows: one more cash sale at this branch
    // raises what the drawer *should* hold, while the counted total stays where it was.
    // Stock is topped up by exactly what the sale consumes, so inventory nets to zero and
    // later tests see what they expected.
    await prisma.inventory.updateMany({
      where: { tenantId, branchId, productItemId: itemAId },
      data: { stock: { increment: 1 } },
    });
    await http()
      .post('/orders')
      .set(auth())
      .send({
        branchId,
        paymentMethod: 'CASH',
        // itemA sells for 200.000 and the price is the catalogue's now, so this is exact
        // money: no change row, and every delta below is a clean +200.000.
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
    // A sale rung up after the last END lands in the closing stretch, where nobody held
    // the drawer - exactly the shape of "money went in the till after it was counted".
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

    // varianceOnly filters across the whole range before paging, so it either keeps this
    // session or drops it according to the number above - never according to the page.
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
    // The old schema's plain unique on (tenant, branch, status) made this impossible from
    // the second day onwards - a branch could only ever hold one CLOSED session.
    const previous = await prisma.cashDrawerSession.findUnique({
      where: { id: sessionId },
      select: { businessDate: true },
    });
    // Move yesterday's session off today's date so the per-day unique doesn't fire.
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

    // The role holds read_own, not read - cashier 1 worked the first session only.
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
    // The guard has to advance even when nothing about the session changes - a START or a
    // no-handover END writes only to the shift-log table. Before the fix, `updateMany` with
    // an empty `data` matched the row without touching `updatedAt`, so a double tap or a
    // client retry produced two identical logs and a shortfall stopped being attributable.
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
    // A cashier granted cash_drawers:read but never posted to a branch used to fall through
    // to "no branch filter" and see every till in the tenant.
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

    // Take their posting away.
    await prisma.user.update({
      where: { id: drifter.body.data.id },
      data: { branchId: null },
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
    // A `@db.Time` column comes back as a Date; the API keeps the old HH:mm strings.
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
          // Same slot, different person - must merge into one schedule, not two.
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

    // 08:00 Vietnam is 01:00 UTC - the shift interval is built at +07:00, not server time.
    expect(rostered.body.data[0].startAt).toContain('T01:00:00');

    // A night shift ends the next calendar day.
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

    // Same person, overlapping window, different shift → refused.
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
    // 2026-09-10 is a Thursday and not a holiday.
    expect(listed.body.data[0].dayInfo.dayType).toBe('NORMAL');
    // Nobody has clocked in yet.
    expect(listed.body.data[0].assignedUsers[0].attendance.status).toBe(
      'NOT_CHECKED_IN',
    );
    note('list: date range filter + dayInfo + attendance summary OK');

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

    // Their role was last set to [orders:read, cash_drawers:read_own, cash_drawers:report]
    // - no stock_movement at all, so this is refused outright.
    await http().get('/stock-movements').set(auth(staffToken)).expect(403);

    // Put them in charge of a shift that is running right now, at their own branch.
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

    // Same account, same token - the rights come from the clock, not from a new login.
    const supervising = await http()
      .get('/stock-movements')
      .set(auth(staffToken))
      .expect(200);
    expect(supervising.body.success).toBe(true);
    note(
      'shift supervisor: stock_movement:read granted mid-shift on the same token OK',
    );

    // Move the shift into the past - the grant expires by the clock, nothing revokes it.
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

  it('spends and refunds the leave balance, and hands shifts over', async () => {
    await http()
      .patch(`/roles/${roleId}`)
      .set(auth())
      .send({
        permissions: [
          { resource: 'leaveRequests', action: 'read_mine' },
          { resource: 'leaveRequests', action: 'cancel' },
        ],
      })
      .expect(200);

    const staffLogin = await http()
      .post('/auth/login')
      .send({ phoneNumber: PHONE_STAFF, password: 'newpass123' })
      .expect(201);
    const staffToken = staffLogin.body.data.accessToken;

    // Opening balance, so the arithmetic below has something to move.
    await http()
      .post(`/users/${staffId}/leave-balance`)
      .set(auth())
      .send({ annualLeaveDays: 12 })
      .expect(201);

    const before = await http()
      .get('/leave-requests/balance')
      .set(auth(staffToken))
      .expect(200);
    expect(before.body.data.remainingDays).toBe(12);

    // A shift the requester supervises inside the leave window - this is what has to be
    // handed over, and what decides a handover is needed at all.
    const managed = await prisma.workingSchedule.create({
      data: {
        tenantId,
        managedById: staffId,
        shiftTemplateId,
        scheduleType: 'NORMAL',
        workDate: new Date('2026-10-06T00:00:00.000Z'),
        startAt: new Date('2026-10-06T01:00:00.000Z'),
        endAt: new Date('2026-10-06T05:00:00.000Z'),
        status: 'SCHEDULED',
        assignedUsers: { create: [{ userId: staffId }] },
      },
      select: { id: true },
    });

    const preview = await http()
      .post('/leave-requests/handover/preview')
      .set(auth(staffToken))
      .send({ startDate: '2026-10-05', endDate: '2026-10-07' })
      .expect(200);
    expect(preview.body.data.requiresHandover).toBe(true);
    expect(preview.body.data.count).toBe(1);
    note('handover preview: 1 shift would be stranded OK');

    // Filing without naming anyone to take over is refused.
    await http()
      .post('/leave-requests')
      .set(auth(staffToken))
      .send({
        startDate: '2026-10-05',
        endDate: '2026-10-07',
        reason: 'Việc gia đình',
      })
      .expect(400);

    const filed = await http()
      .post('/leave-requests')
      .set(auth(staffToken))
      .send({
        startDate: '2026-10-05',
        endDate: '2026-10-07',
        reason: 'Việc gia đình',
        handoverToUserId: secondStaffId,
      })
      .expect(201);
    leaveRequestId = filed.body.data.id;
    expect(filed.body.handover.required).toBe(true);
    expect(filed.body.data.status).toBe('PENDING');

    // Overlapping the same days again is refused while the first is still live.
    await http()
      .post('/leave-requests')
      .set(auth(staffToken))
      .send({
        startDate: '2026-10-06',
        endDate: '2026-10-08',
        reason: 'Trùng ngày',
        handoverToUserId: secondStaffId,
      })
      .expect(409);
    note('overlapping leave request: 409 OK');

    // Nobody approves their own leave, whatever they hold.
    await http()
      .post(`/leave-requests/${leaveRequestId}/approve`)
      .set(auth(staffToken))
      .send({ paidLeaveDays: 3, unpaidLeaveDays: 0 })
      .expect(403);

    // 3 requested, 4 approved - more days than were asked for.
    await http()
      .post(`/leave-requests/${leaveRequestId}/approve`)
      .set(auth())
      .send({ paidLeaveDays: 4, unpaidLeaveDays: 0 })
      .expect(400);

    const approved = await http()
      .post(`/leave-requests/${leaveRequestId}/approve`)
      .set(auth())
      .send({ paidLeaveDays: 2, unpaidLeaveDays: 1 })
      .expect(200);
    expect(approved.body.data.status).toBe('APPROVED');

    const spent = await http()
      .get('/leave-requests/balance')
      .set(auth(staffToken))
      .expect(200);
    expect(spent.body.data.remainingDays).toBe(10);
    expect(spent.body.data.usedDays).toBe(2);

    // The shift moved to the person taking over.
    const handedOver = await prisma.workingSchedule.findUniqueOrThrow({
      where: { id: managed.id },
      select: { managedById: true },
    });
    expect(handedOver.managedById).toBe(secondStaffId);
    note('approve: 2 paid days spent, shift handed over OK');

    const cancelled = await http()
      .post(`/leave-requests/${leaveRequestId}/cancel`)
      .set(auth(staffToken))
      .expect(200);
    expect(cancelled.body.data.status).toBe('CANCELLED');

    const refunded = await http()
      .get('/leave-requests/balance')
      .set(auth(staffToken))
      .expect(200);
    expect(refunded.body.data.remainingDays).toBe(12);

    // **Back to the original supervisor, not to nobody** - iKiotMS-BE set this to null.
    const restored = await prisma.workingSchedule.findUniqueOrThrow({
      where: { id: managed.id },
      select: { managedById: true },
    });
    expect(restored.managedById).toBe(staffId);
    note('cancel: 2 days refunded, shift returned to the original manager OK');

    await prisma.leaveRequestHandoverSchedule.deleteMany({
      where: { scheduleId: managed.id },
    });
    await prisma.workingScheduleUser.deleteMany({
      where: { scheduleId: managed.id },
    });
    await prisma.workingSchedule.delete({ where: { id: managed.id } });
  });

  it('clocks in and out inside the geofence', async () => {
    // The branch needs a geofence before anyone can clock in against it.
    await http()
      .patch(`/branches/${branchId}`)
      .set(auth())
      .send({
        attendanceTakingLocation: {
          latitude: 10.772,
          longitude: 106.698,
          allowedRadiusMeters: 100,
          maxAccuracyMeters: 100,
        },
      })
      .expect(200);

    // A shift that is running right now, so the check-in window is open.
    const now = new Date();
    const shift = await prisma.workingSchedule.create({
      data: {
        tenantId,
        managedById: staffId,
        shiftTemplateId,
        scheduleType: 'NORMAL',
        workDate: new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`),
        startAt: new Date(now.getTime() - 90 * 60 * 1000),
        endAt: new Date(now.getTime() + 90 * 60 * 1000),
        status: 'SCHEDULED',
        assignedUsers: { create: [{ userId: staffId }] },
      },
      select: { id: true, startAt: true },
    });

    const staffLogin = await http()
      .post('/auth/login')
      .send({ phoneNumber: PHONE_STAFF, password: 'newpass123' })
      .expect(201);
    const staffToken = staffLogin.body.data.accessToken;

    await http()
      .patch(`/roles/${roleId}`)
      .set(auth())
      .send({
        permissions: [
          { resource: 'attendances', action: 'create' },
          { resource: 'attendances', action: 'update' },
          { resource: 'attendances', action: 'read_own' },
        ],
      })
      .expect(200);

    // Standing 330m away with a good fix: they are simply not at work.
    const away = await http()
      .post('/attendances/check-in')
      .set(auth(staffToken))
      .send({
        scheduleId: shift.id,
        actualCheckinAt: now.toISOString(),
        checkInLocation: { latitude: 10.775, longitude: 106.698, accuracy: 5 },
      })
      .expect(403);
    expect(away.body.errors.verificationStatus).toBe('OUT_OF_RANGE');

    // At the shop, but the phone doesn't know where it is - a different failure.
    const vague = await http()
      .post('/attendances/check-in')
      .set(auth(staffToken))
      .send({
        scheduleId: shift.id,
        actualCheckinAt: now.toISOString(),
        checkInLocation: {
          latitude: 10.772,
          longitude: 106.698,
          accuracy: 500,
        },
      })
      .expect(422);
    expect(vague.body.errors.verificationStatus).toBe('LOW_ACCURACY');

    // 60 minutes after the shift started, grace is 15 → the full 60 counts.
    const checkinAt = new Date(shift.startAt!.getTime() + 60 * 60 * 1000);
    const checkedIn = await http()
      .post('/attendances/check-in')
      .set(auth(staffToken))
      .send({
        scheduleId: shift.id,
        actualCheckinAt: checkinAt.toISOString(),
        checkInLocation: { latitude: 10.772, longitude: 106.698, accuracy: 10 },
      })
      .expect(201);
    const attendanceId = checkedIn.body.data.attendance.id;
    expect(checkedIn.body.data.attendance.status).toBe('CHECKED_IN');
    expect(checkedIn.body.data.geo.verificationStatus).toBe('VERIFIED');
    // Stored, not just derived - iKiotMS-BE never wrote this column.
    expect(checkedIn.body.data.attendance.lateMinutes).toBe(60);
    note('check-in: geofence VERIFIED, lateMinutes stored (60, grace 15) OK');

    await http()
      .post('/attendances/check-in')
      .set(auth(staffToken))
      .send({
        scheduleId: shift.id,
        actualCheckinAt: checkinAt.toISOString(),
        checkInLocation: { latitude: 10.772, longitude: 106.698, accuracy: 10 },
      })
      .expect(409);
    note('check-in twice for one shift: 409 OK');

    const checkedOut = await http()
      .post('/attendances/check-out')
      .set(auth(staffToken))
      .send({
        attendanceId,
        actualCheckoutAt: new Date(
          checkinAt.getTime() + 30 * 60 * 1000,
        ).toISOString(),
        checkOutLocation: {
          latitude: 10.772,
          longitude: 106.698,
          accuracy: 10,
        },
      })
      .expect(200);
    expect(checkedOut.body.data.attendance.status).toBe('CHECKED_OUT');
    expect(checkedOut.body.data.attendance.workedMinutes).toBe(30);
    note('check-out: workedMinutes 30, CHECKED_OUT OK');

    // The filter the old system shipped with and could never satisfy.
    const late = await http()
      .get('/attendances/me?lateOnly=true')
      .set(auth(staffToken))
      .expect(200);
    expect(late.body.pagination.total).toBe(1);
    expect(late.body.data[0].id).toBe(attendanceId);
    note(
      'GET /attendances/me?lateOnly=true: 1 row (was always empty before) OK',
    );

    // A manager cannot correct their own attendance, whatever their permissions.
    const ownEdit = await http()
      .patch(`/attendances/${attendanceId}/manual-checkout`)
      .set(auth(staffToken))
      .send({ actualCheckoutAt: now.toISOString(), reason: 'tự sửa' })
      .expect(403);
    expect(ownEdit.body.code).toBe('ATTENDANCE_SELF_CORRECTION_DENIED');
    note('manual-checkout on your own record: 403 OK');

    await prisma.attendance.deleteMany({ where: { scheduleId: shift.id } });
    await prisma.workingScheduleUser.deleteMany({
      where: { scheduleId: shift.id },
    });
    await prisma.workingSchedule.delete({ where: { id: shift.id } });
  });

  it('runs a payroll period from draft to paid', async () => {
    await http()
      .post('/payroll/settings')
      .set(auth())
      .send({ standardWorkingDays: 26, standardWorkingHoursPerDay: 8 })
      .expect(201);

    const paysheet = await http()
      .post('/payroll/paysheets')
      .set(auth())
      .send({
        name: 'Ca 400k',
        basicPay: { payType: 'PAY_BY_SHIFT', amountPerShift: 400_000 },
        deductions: [
          {
            name: 'Đi muộn',
            enable: true,
            deductionType: 'LATE',
            conditionType: 'BY_OCCURRENCE',
            deductionValue: 50_000,
          },
        ],
      })
      .expect(201);
    paysheetId = paysheet.body.data.id;

    // A FIXED paysheet with no salary is refused at configuration time, not at month end.
    await http()
      .post('/payroll/paysheets')
      .set(auth())
      .send({ name: 'Thiếu lương', basicPay: { payType: 'FIXED' } })
      .expect(400);

    await http()
      .patch(`/users/${staffId}`)
      .set(auth())
      .send({ paysheetId })
      .expect(200);

    // One worked shift last month: 09:00–17:00 Vietnam on a Monday, clocked in 40 minutes
    // late (grace is 15, so the whole 40 counts and the LATE rule charges once).
    const worked = await prisma.workingSchedule.create({
      data: {
        tenantId,
        managedById: staffId,
        shiftTemplateId,
        scheduleType: 'NORMAL',
        workDate: new Date('2026-07-06T00:00:00.000Z'),
        startAt: new Date('2026-07-06T02:00:00.000Z'),
        endAt: new Date('2026-07-06T10:00:00.000Z'),
        status: 'SCHEDULED',
        assignedUsers: { create: [{ userId: staffId }] },
      },
      select: { id: true },
    });
    await prisma.attendance.create({
      data: {
        tenantId,
        userId: staffId,
        scheduleId: worked.id,
        workDate: new Date('2026-07-06T00:00:00.000Z'),
        actualCheckinAt: new Date('2026-07-06T02:40:00.000Z'),
        actualCheckoutAt: new Date('2026-07-06T10:00:00.000Z'),
        lateMinutes: 40,
        status: 'CHECKED_OUT',
      },
    });

    const preview = await http()
      .post('/payroll/preview')
      .set(auth())
      .send({ payrollMonth: '2026-07', userIds: [staffId] })
      .expect(200);
    const slip = preview.body.data.payslips[0];
    // A LATE rule is configured, so the 40 minutes lost to arriving late are restored to
    // the payable time - the penalty takes the money instead. Full shift, full 400k.
    expect(slip.basePay).toBe(400_000);
    expect(slip.deduction).toBe(50_000);
    expect(slip.netSalary).toBe(350_000);
    expect(slip.totalWorkedDays).toBe(1);
    note('payroll preview: late restored to time, charged once as 50k OK');

    // A period that hasn't ended yet cannot be generated.
    const future = new Date();
    const futureMonth = `${future.getUTCFullYear() + 1}-01`;
    await http()
      .post('/payroll/periods')
      .set(auth())
      .send({ payrollMonth: futureMonth })
      .expect(422);

    const generated = await http()
      .post('/payroll/periods')
      .set(auth())
      .send({ payrollMonth: '2026-07', userIds: [staffId] })
      .expect(201);
    payrollPeriodId = generated.body.data.payrollPeriod.id;
    expect(generated.body.data.payrollPeriod.status).toBe('DRAFT');

    // A second period over the same month collides.
    await http()
      .post('/payroll/periods')
      .set(auth())
      .send({ payrollMonth: '2026-07', userIds: [staffId] })
      .expect(409);
    note('generate: DRAFT created, overlapping period 409 OK');

    const detail = await http()
      .get(`/payroll/periods/${payrollPeriodId}`)
      .set(auth())
      .expect(200);
    expect(detail.body.payrollPeriod.totalCost).toBe(350_000);
    const payslipId = detail.body.data[0].id;

    // A manual advance comes off the net, and the payslip is re-totalled from its stored
    // components rather than from the previous net - editing twice must not compound.
    const adjusted = await http()
      .patch(`/payroll/periods/${payrollPeriodId}/payslips/${payslipId}`)
      .set(auth())
      .send({
        manualAdjustments: [
          { category: 'SALARY_ADVANCE', name: 'Ứng lương', amount: -100_000 },
        ],
      })
      .expect(200);
    expect(adjusted.body.data.payslip.netSalary).toBe(250_000);

    await http()
      .patch(`/payroll/periods/${payrollPeriodId}/payslips/${payslipId}`)
      .set(auth())
      .send({
        manualAdjustments: [
          { category: 'SALARY_ADVANCE', name: 'Ứng lương', amount: -100_000 },
        ],
      })
      .expect(200);
    const stillOnce = await http()
      .get(`/payroll/periods/${payrollPeriodId}/payslips/${payslipId}`)
      .set(auth())
      .expect(200);
    expect(stillOnce.body.data.netSalary).toBe(250_000);
    note('draft edit: advance applied once, re-editing does not compound OK');

    // An adjustment that would make the net negative is refused.
    await http()
      .patch(`/payroll/periods/${payrollPeriodId}/payslips/${payslipId}`)
      .set(auth())
      .send({
        manualAdjustments: [
          { category: 'OTHER', name: 'Quá tay', amount: -999_999 },
        ],
      })
      .expect(422);

    // Approving straight from DRAFT skips REVIEW.
    await http()
      .post(`/payroll/periods/${payrollPeriodId}/approve`)
      .set(auth())
      .send({})
      .expect(409);

    await http()
      .post(`/payroll/periods/${payrollPeriodId}/submit`)
      .set(auth())
      .send({})
      .expect(200);

    // Returning to draft needs a reason.
    await http()
      .post(`/payroll/periods/${payrollPeriodId}/return-to-draft`)
      .set(auth())
      .send({})
      .expect(400);

    await http()
      .post(`/payroll/periods/${payrollPeriodId}/approve`)
      .set(auth())
      .send({})
      .expect(200);

    const paid = await http()
      .post(`/payroll/periods/${payrollPeriodId}/mark-paid`)
      .set(auth())
      .send({ paymentNote: 'Trả tay' })
      .expect(200);
    expect(paid.body.data.status).toBe('PAID');
    // Server-owned: the client never names a payment method.
    expect(paid.body.data.paymentMethod).toBe('CASH');
    expect(paid.body.data.cashFlowReference).toMatch(/^PAYR/);

    // The ledger row and the status are written together - one can't exist without the
    // other, and `CashFlow.payrollPeriodId` is unique so a replay writes no second row.
    const ledger = await prisma.cashFlow.findMany({
      where: { tenantId, payrollPeriodId },
      select: { amount: true, flowType: true },
    });
    expect(ledger).toHaveLength(1);
    expect(Number(ledger[0].amount)).toBe(250_000);
    expect(ledger[0].flowType).toBe('EXPENSE');
    note(
      'mark-paid: PAID + one PAYR expense row of 250k, method server-owned OK',
    );

    // The employee can now see it; a DRAFT one they could not.
    const staffLogin = await http()
      .post('/auth/login')
      .send({ phoneNumber: PHONE_STAFF, password: 'newpass123' })
      .expect(201);
    await http()
      .patch(`/roles/${roleId}`)
      .set(auth())
      .send({ permissions: [{ resource: 'payslips', action: 'read_own' }] })
      .expect(200);

    const mine = await http()
      .get('/payroll/my-payslips')
      .set(auth(staffLogin.body.data.accessToken))
      .expect(200);
    expect(mine.body.pagination.total).toBe(1);
    expect(mine.body.data[0].netSalary).toBe(250_000);
    note('my-payslips: employee sees the PAID slip OK');

    await prisma.attendance.deleteMany({ where: { scheduleId: worked.id } });
    await prisma.workingScheduleUser.deleteMany({
      where: { scheduleId: worked.id },
    });
    await prisma.workingSchedule.delete({ where: { id: worked.id } });
  });

  it('prices the revenue-tier bonus on a paysheet', async () => {
    // Neither codebase ever priced this: both wrote a literal `bonus = 0` under a comment
    // saying the configuration was stored but not applied. Every number below is therefore
    // a decision the shop owner made on 2026-09-06, not a ported behaviour.
    const walkIn = await prisma.customer.findFirstOrThrow({
      where: { tenantId, customerCode: 'KH_VANGLAI' },
      select: { id: true },
    });

    // June 2026, so this has its own payroll period and cannot disturb the July one the
    // previous test already generated and paid.
    const june = (day: number, hour = 5) =>
      new Date(Date.UTC(2026, 5, day, hour));

    /** A completed sale by this cashier, with the moment its money landed as a separate
     *  fact - that separation is what tells NET_REVENUE from COLLECTED_REVENUE apart. */
    const sell = async (args: {
      unitPrice: number;
      discount: number;
      soldAt: Date;
      paidAt: Date;
    }) => {
      const grandTotal = args.unitPrice - args.discount;
      const order = await prisma.order.create({
        data: {
          tenantId,
          branchId,
          customerId: walkIn.id,
          userId: staffId,
          status: 'COMPLETED',
          paymentMethod: 'CASH',
          grandTotal,
          createdAt: args.soldAt,
          items: {
            create: [
              {
                productItemId: itemAId,
                quantity: 1,
                unitPrice: args.unitPrice,
                discountAmount: args.discount,
              },
            ],
          },
        },
        select: { id: true },
      });
      await prisma.cashFlow.create({
        data: {
          tenantId,
          branchId,
          orderId: order.id,
          flowType: 'INCOME',
          amount: grandTotal,
          paymentMethod: 'CASH',
          createdAt: args.paidAt,
        },
      });
      return order.id;
    };

    // Two sales paid the day they were rung up, and one SePay sale whose money only landed
    // in July - a real case, and the only thing that separates the cash basis from the
    // accrual one.
    await sell({
      unitPrice: 3_000_000,
      discount: 500_000,
      soldAt: june(8),
      paidAt: june(8),
    });
    await sell({
      unitPrice: 5_000_000,
      discount: 500_000,
      soldAt: june(9),
      paidAt: june(9),
    });
    await sell({
      unitPrice: 3_000_000,
      discount: 0,
      soldAt: june(30, 16),
      paidAt: new Date(Date.UTC(2026, 6, 1, 3)),
    });

    //   GROSS     = 3.0 + 5.0 + 3.0 = 11.0tr   (before discount)
    //   NET       = 2.5 + 4.5 + 3.0 = 10.0tr   (after discount)
    //   COLLECTED = 2.5 + 4.5       =  7.0tr   (the third sale's money landed in July)
    const withBonus = (calculationType: string, extra: unknown[] = []) =>
      http()
        .put(`/payroll/paysheets/${paysheetId}`)
        .set(auth())
        .send({
          name: 'Ca 400k',
          basicPay: { payType: 'PAY_BY_SHIFT', amountPerShift: 400_000 },
          deductions: [
            {
              name: 'Đi muộn',
              enable: true,
              deductionType: 'LATE',
              conditionType: 'BY_OCCURRENCE',
              deductionValue: 50_000,
            },
          ],
          bonuses: [
            {
              bonusType: 'EMPLOYEE_REVENUE',
              calculationType,
              enable: true,
              tiers: [
                {
                  name: 'Bậc 1',
                  fromValue: 3_000_000,
                  rewardType: 'PERCENTAGE',
                  rewardValue: 5,
                },
                {
                  name: 'Bậc 2',
                  fromValue: 5_000_000,
                  rewardType: 'PERCENTAGE',
                  rewardValue: 14,
                },
              ],
            },
            ...extra,
          ],
        })
        .expect(200);

    const previewJune = async () => {
      const preview = await http()
        .post('/payroll/preview')
        .set(auth())
        .send({ payrollMonth: '2026-06', userIds: [staffId] })
        .expect(200);
      return preview.body.data.payslips[0];
    };

    // ── The three revenue figures are genuinely different numbers ────────────
    await withBonus('NET_REVENUE');
    const net = await previewJune();
    expect(net.bonusLines).toHaveLength(1);
    expect(net.bonusLines[0]).toMatchObject({
      bonusType: 'EMPLOYEE_REVENUE',
      calculationType: 'NET_REVENUE',
      revenue: 10_000_000,
      tierName: 'Bậc 2',
      amount: 1_400_000,
    });
    expect(net.bonus).toBe(1_400_000);

    await withBonus('GROSS_REVENUE');
    const gross = await previewJune();
    expect(gross.bonusLines[0].revenue).toBe(11_000_000);
    expect(gross.bonus).toBe(1_540_000);

    await withBonus('COLLECTED_REVENUE');
    const collected = await previewJune();
    // The June sale settled on 1 July is out: its money moved in the next period.
    expect(collected.bonusLines[0].revenue).toBe(7_000_000);
    // The worked example from the decision: 7tr against 5tr→14%, flat, on the whole figure.
    expect(collected.bonus).toBe(980_000);
    // Not the two readings it was chosen over.
    expect(collected.bonus).not.toBe(380_000);
    expect(collected.bonus).not.toBe(1_330_000);
    note(
      `bonus: gộp ${gross.bonusLines[0].revenue} → ${gross.bonus}, thuần ${net.bonusLines[0].revenue} → ${net.bonus}, thực thu ${collected.bonusLines[0].revenue} → ${collected.bonus} OK`,
    );

    // No shifts in June, so pay is a bare deduction; the bonus is what lifts it.
    expect(collected.netSalary).toBe(
      collected.grossSalary +
        collected.bonus +
        collected.allowance -
        collected.deduction,
    );

    // ── The income floor sees the commission, and lands exactly on its promise ──
    await withBonus('COLLECTED_REVENUE', [
      {
        bonusType: 'MINIMUM_AVENUE_INCOME',
        calculationType: 'COLLECTED_REVENUE',
        enable: true,
        tiers: [
          {
            name: 'Đảm bảo',
            fromValue: 0,
            rewardType: 'FIXED_AMOUNT',
            rewardValue: 3_000_000,
          },
        ],
      },
    ]);
    const guaranteed = await previewJune();
    const floorLine = guaranteed.bonusLines.find(
      (line: any) => line.bonusType === 'MINIMUM_AVENUE_INCOME',
    );
    // Take-home is exactly the guarantee: the floor topped up what was still missing after
    // the 980k commission, rather than paying the whole guarantee on top of it.
    expect(guaranteed.netSalary).toBe(3_000_000);
    expect(guaranteed.bonus).toBe(980_000 + floorLine.amount);
    expect(floorLine.amount).toBeLessThan(3_000_000);
    note(
      `đảm bảo thu nhập: hoa hồng 980.000 + bù ${floorLine.amount} ⇒ thực nhận đúng 3.000.000 OK`,
    );

    // ── And it survives being written down ──────────────────────────────────
    const period = await http()
      .post('/payroll/periods')
      .set(auth())
      .send({ payrollMonth: '2026-06', userIds: [staffId] })
      .expect(201);

    const saved = await prisma.payslip.findFirstOrThrow({
      where: {
        payrollPeriodId: period.body.data.payrollPeriod.id,
        userId: staffId,
      },
      include: { bonusLines: true },
    });
    expect(Number(saved.bonus)).toBe(guaranteed.bonus);
    expect(saved.bonusLines).toHaveLength(2);
    const commissionRow = saved.bonusLines.find(
      (line) => line.bonusType === 'EMPLOYEE_REVENUE',
    )!;
    // The tier is snapshotted, not referenced: the paysheet was rewritten four times in
    // this test alone, and a payslip has to still explain itself afterwards.
    expect(Number(commissionRow.revenue)).toBe(7_000_000);
    expect(commissionRow.tierName).toBe('Bậc 2');
    expect(Number(commissionRow.fromValue)).toBe(5_000_000);
    expect(Number(commissionRow.amount)).toBe(980_000);
    note(
      `phiếu lương lưu ${saved.bonusLines.length} dòng thưởng kèm bậc đã chốt, tổng ${Number(saved.bonus)} OK`,
    );
  });

  it('manages the public holiday calendar', async () => {
    const created = await http()
      .post('/holidays')
      .set(auth())
      .send({ date: '2026-09-02', name: 'Quốc khánh' })
      .expect(201);
    expect(created.body.data.source).toBe('MANUAL');
    // Anything a human made is stamped, so the Google sync leaves it alone forever.
    expect(created.body.data.isManuallyEdited).toBe(true);
    const holidayId = created.body.data.id;

    // Restores what the Mongo compound index enforced: Postgres ignores NULL branch_id in
    // the plain @@unique, so this only holds because of the partial-index migration.
    await http()
      .post('/holidays')
      .set(auth())
      .send({ date: '2026-09-02', name: 'Trùng ngày' })
      .expect(409);

    // Shape passes the regex, but that day doesn't exist.
    await http()
      .post('/holidays')
      .set(auth())
      .send({ date: '2026-02-31', name: 'Không có thật' })
      .expect(400);

    // Turning a holiday off is its own route; PATCH refuses the field outright.
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

    // A different year must not match it.
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

  // Refresh tokens live in Redis (docker compose up -d redis). The suite asserts the
  // whole session lifecycle the old system had and the first port dropped: rotation,
  // one-time use, logout, and "changing a password ends every other session".
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

    // Rotation: the token just spent is dead, so a replay (or a stolen copy) fails.
    await http()
      .post('/auth/refresh')
      .send({ refreshToken: first })
      .expect(401);
    note('refresh: rotates and the spent token is refused (401) OK');

    // The new access token really works.
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

    // Both sessions, not just the other one: the old system revoked by userId.
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

    // DEV_BYPASS is the dev escape hatch the old otpService carried; NODE_ENV=test here.
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

    // An access token is not a reset token, however valid its signature.
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

  // Regression: /tenants is a platform resource on a model with no tenantId of its own,
  // and PermissionsGuard short-circuits TENANT_OWNER - so @Permissions alone left every
  // shop owner able to read, edit and delete every other tenant, and read their SePay
  // webhook key with it. AdminOnlyGuard is what closes that.
  // The dashboard. Four of these answers are hand-written SQL (local-day bucketing, line
  // revenue, stock valuation), which typecheck proves nothing about - so each one is run
  // against the real Postgres here and the numbers checked against what the earlier tests
  // in this file actually sold.
  it('reports the shop dashboard off real sales', async () => {
    const overview = await http()
      .get('/stats/overview')
      .set(auth())
      .expect(200);
    expect(overview.body.data.revenue).toBeGreaterThan(0);
    expect(overview.body.data.orderCount).toBeGreaterThan(0);
    // aov = round(revenue / orderCount), recomputed here rather than trusted.
    expect(overview.body.data.aov).toBe(
      Math.round(overview.body.data.revenue / overview.body.data.orderCount),
    );
    // Nothing was sold in the 30 days before this run, so every change is "from zero" -
    // null, deliberately, rather than 0 or Infinity.
    expect(overview.body.data.changePct.revenue).toBeNull();
    note('GET /stats/overview: revenue, AOV, null change-from-zero OK');

    // The bucket must be the shop's local day. Everything this suite created happened just
    // now, so there is exactly one bucket and it is today in Ho Chi Minh City.
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
    // Sorted by revenue descending, like the old $sort stage.
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

    // Cashflow: the ledger view of the same sales, plus the payroll expense marked paid
    // earlier in this suite. `flow=ORD` isolates the sales half by reference prefix.
    const cash = await http().get('/stats/cashflow').set(auth()).expect(200);
    expect(cash.body.data.income).toBeGreaterThan(0);
    expect(cash.body.data.expense).toBeGreaterThan(0);
    expect(cash.body.data.net).toBe(
      cash.body.data.income - cash.body.data.expense,
    );

    // ORD is not "income" - a refunded order writes an ORD-prefixed EXPENSE, so the sales
    // flow has both sides. What it must not contain is payroll.
    const salesOnly = await http()
      .get('/stats/cashflow?flow=ORD')
      .set(auth())
      .expect(200);
    expect(salesOnly.body.data.income).toBe(cash.body.data.income);
    expect(salesOnly.body.data.expense).toBeGreaterThan(0);

    const payrollOnly = await http()
      .get('/stats/cashflow?flow=PAYR')
      .set(auth())
      .expect(200);
    expect(payrollOnly.body.data.income).toBe(0);
    // The two flows partition the expense side between them.
    expect(payrollOnly.body.data.expense + salesOnly.body.data.expense).toBe(
      cash.body.data.expense,
    );
    note('GET /stats/cashflow: flow=ORD / flow=PAYR partition the ledger OK');

    const transactions = await http()
      .get('/stats/cashflow/transactions?page=1&limit=5')
      .set(auth())
      .expect(200);
    expect(transactions.body.data.length).toBeGreaterThan(0);
    expect(transactions.body.pagination.total).toBeGreaterThan(0);
    const payrollRow = transactions.body.data.find(
      (row: { paymentReference: string | null }) =>
        row.paymentReference?.startsWith('PAYR'),
    );
    expect(payrollRow.flowType).toBe('EXPENSE');
    expect(payrollRow.locationType).toBeNull();
    note('GET /stats/cashflow/transactions: paginated, names resolved OK');

    const inventory = await http()
      .get('/stats/inventory?lowStockThreshold=1000')
      .set(auth())
      .expect(200);
    expect(inventory.body.data.skuCount).toBeGreaterThan(0);
    expect(inventory.body.data.stockValue).toBeGreaterThan(0);
    expect(inventory.body.data.lowStock.length).toBeGreaterThan(0);
    // Polymorphic location split into two nullable columns - exactly one is set.
    const row = inventory.body.data.lowStock[0];
    expect(Boolean(row.branchId) !== Boolean(row.warehouseId)).toBe(true);
    expect(row.locationType).toBe(row.branchId ? 'branch' : 'warehouse');
    note('GET /stats/inventory: valuation joins cost price, low-stock list OK');
  });

  it('scopes the dashboard by posting, and keeps the platform view for admins', async () => {
    const staffLogin = await http()
      .post('/auth/login')
      .send({ phoneNumber: PHONE_STAFF, password: 'newpass123' })
      .expect(201);
    const staffToken = staffLogin.body.data.accessToken;

    // Without reports:read the dashboard is closed to them at the guard, before any
    // scoping runs. (PATCH /roles replaces the whole permission set, so this also proves
    // the previous test's payslips:read_own is gone.)
    await http().get('/stats/overview').set(auth(staffToken)).expect(403);

    await http()
      .patch(`/roles/${roleId}`)
      .set(auth())
      .send({ permissions: [{ resource: 'reports', action: 'read' }] })
      .expect(200);

    // The old system let anyone holding reports:read see every branch. A posted account is
    // now pinned to its own location, and naming someone else's is refused rather than
    // silently ignored - the failure mode that let a manager misread another branch's
    // numbers as their own.
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
    // Ticket statuses are folded into two buckets; nothing may fall between them (the
    // enum's unreachable RESOLVED counts as resolved, not as a missing status).
    expect(platform.body.data.tickets.total).toBe(
      platform.body.data.tickets.open + platform.body.data.tickets.resolved,
    );
    // This tenant had its SePay key set earlier, so at least one shop is linked.
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

  // Support threads. The whole point of the module is the two-sided conversation, so this
  // walks one thread end to end rather than poking each route in isolation: the shop opens
  // it, an operator answers, the shop answers back, the operator closes it, and only then
  // does replying fail.
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
    // Not the old `TK-<epoch><2 digits>` scheme - same generator as every other reference.
    expect(opened.body.data.ticketId).toMatch(/^TK[0-9A-F]{10}$/);
    expect(opened.body.data.status).toBe('OPEN');
    // The description is the opening message too, so the thread is self-contained.
    expect(opened.body.data.messages).toHaveLength(1);
    expect(opened.body.data.messages[0].message).toContain('máy in ở quầy 1');
    note('POST /tickets: TK reference, status OPEN, opening message OK');

    // The operators' inbox row is a system notification - tenantId and recipientId both
    // null - not a notification addressed to anyone in the shop.
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

    // Unlike the open event, an answer has to reach the owner's own inbox.
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
    // Back to OPEN - the thread needs an operator again.
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

    // Soft delete only, and one-sided: gone from the shop's list, still in the operators'.
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

  // AI conversations. `/ai/chat` itself is not exercised here - it would spend real Gemini
  // quota on every run and fail whenever the network or the model name moved; the agent
  // loop is covered by ai-agent.service.spec.ts against a scripted model. What is proved
  // here is everything around it: the permission gate, per-person scoping, and the CRUD.
  it('keeps AI conversations private to the person who had them', async () => {
    const staffLogin = await http()
      .post('/auth/login')
      .send({ phoneNumber: PHONE_STAFF, password: 'newpass123' })
      .expect(201);
    const staffToken = staffLogin.body.data.accessToken;

    // The old routes were gated on two fixed roles that no longer exist; the shop now
    // decides who may use the assistant, through the ai_chat catalog resource.
    await http().get('/ai/conversations').set(auth(staffToken)).expect(403);
    await http()
      .post('/ai/chat')
      .set(auth(staffToken))
      .send({ message: 'doanh thu tháng này?' })
      .expect(403);
    note('ai: staff without ai_chat on /ai/chat and /ai/conversations 403 OK');

    // Seeded directly: creating one through /ai/chat would call Gemini.
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
    // The list is titles only - a transcript is fetched one conversation at a time.
    expect(mine.body.data[0]).not.toHaveProperty('messages');
    expect(mine.body.data[0].title).toBe('Doanh thu tháng 8');

    const detail = await http()
      .get(`/ai/conversations/${conversation.id}`)
      .set(auth())
      .expect(200);
    expect(detail.body.data.messages).toHaveLength(2);

    // A conversation belongs to one person, not to the shop: grant the staff account the
    // permission and they still cannot read the owner's thread.
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

  // The operators' console. It reads the same table as every shop's inbox, so the thing
  // worth proving is the separation: the feed shows only rows belonging to nobody, and the
  // acknowledge/delete routes cannot reach a shop's private notification by id.
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
    // The ticket opened earlier put a row here; the shop's own notifications must not be in
    // it, and every row must carry the null pair that defines a system notification.
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

    // The old markAsRead had no filter at all - this is the regression it leaves behind.
    // A notification addressed to the shop owner must be unreachable from here.
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

    // An announcement is not a system event: it is written here but must never show up in
    // the feed above.
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

    // targetType=SELECTION with a non-uuid tenant is a 400, not a silent send to nobody.
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

  // Regression: the response envelope. The success half is proved by every assertion
  // above reading `body.data`; this pins the two shapes that aren't an entity - a
  // paginated list merges rather than nesting, and a failure answers `success: false`.
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

    // A ValidationPipe failure keeps its per-field list, under `errors` rather than as
    // the user-facing `message` - the shape the old DTO validators sent.
    const invalid = await http()
      .post('/suppliers')
      .set(auth())
      .send({ supplierName: '' })
      .expect(400);
    expect(invalid.body.success).toBe(false);
    expect(Array.isArray(invalid.body.errors)).toBe(true);

    // The SePay webhook is @RawResponse() - its body belongs to SePay, not to us.
    const webhook = await http()
      .post('/webhook/sepay/order')
      .send({ transferType: 'in' })
      .expect(200);
    expect(webhook.body).toEqual({
      success: false,
      message: 'Unknown API key',
    });
    note(
      'envelope: list merges, errors carry success:false, webhook stays raw OK',
    );
  });
});
