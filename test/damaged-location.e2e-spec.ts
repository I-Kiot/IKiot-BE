import 'dotenv/config';
import { randomUUID } from 'crypto';
import { Test } from '@nestjs/testing';
import { PrismaModule } from './../src/prisma/prisma.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { SubscriptionService } from './../src/modules/subscriptions/subscriptions.service';
import { BranchService } from './../src/modules/branches/branches.service';
import { WarehouseService } from './../src/modules/warehouses/warehouses.service';
import { ErrorCode } from './../src/common/errors/error-codes';

/**
 * Kiểm thử kho hàng hỏng (D-4, contract §3) trên Postgres thật: `isSellable` của kho,
 * `damagedLocationId` của chi nhánh / kho và các quy tắc giữ cho liên kết đó có nghĩa. Hạn mức
 * gói được bỏ qua (SubscriptionService giả); tự tạo hai tenant riêng và dọn sạch.
 */
describe('Damaged-goods locations – BranchService / WarehouseService (D-4)', () => {
  let prisma: PrismaService;
  let branches: BranchService;
  let warehouses: WarehouseService;

  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const phone = ['0900000000'];
  const invalid = { response: { code: ErrorCode.LOCATION_DAMAGED_INVALID } };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [
        BranchService,
        WarehouseService,
        {
          provide: SubscriptionService,
          useValue: { assertQuota: () => Promise.resolve() },
        },
      ],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    branches = moduleRef.get(BranchService);
    warehouses = moduleRef.get(WarehouseService);

    await prisma.tenant.createMany({
      data: [
        { id: tenantId, name: 'damaged-e2e' },
        { id: otherTenantId, name: 'damaged-e2e-other' },
      ],
    });
  });

  afterAll(async () => {
    const tenants = { in: [tenantId, otherTenantId] };
    await prisma.location.updateMany({
      where: { tenantId: tenants },
      data: { damagedLocationId: null },
    });
    await prisma.branch.deleteMany({ where: { tenantId: tenants } });
    await prisma.warehouse.deleteMany({ where: { tenantId: tenants } });
    await prisma.location.deleteMany({ where: { tenantId: tenants } });
    await prisma.tenant.deleteMany({ where: { id: tenants } });
    await prisma.$disconnect();
  });

  let damagedId = '';
  let sellableWarehouseId = '';
  let branchId = '';

  it('creates a damaged-goods warehouse with isSellable = false; a warehouse defaults to sellable', async () => {
    const damaged = await warehouses.create(tenantId, {
      name: 'Kho hàng hỏng',
      phoneNumber: phone,
      isSellable: false,
    });
    damagedId = damaged.id;
    expect(damaged).toMatchObject({
      isSellable: false,
      damagedLocationId: null,
    });

    const main = await warehouses.create(tenantId, {
      name: 'Kho tổng',
      phoneNumber: phone,
    });
    sellableWarehouseId = main.id;
    expect(main).toMatchObject({ isSellable: true });
    // The contract's three fields are on every response.
    expect(main).toHaveProperty('defaultFulfillmentLocationId', null);
  });

  it('creates a branch that sends its damaged goods to that warehouse', async () => {
    const branch = await branches.create(tenantId, {
      name: 'Showroom',
      phoneNumber: phone,
      damagedLocationId: damagedId,
    });
    branchId = branch.id;
    expect(branch).toMatchObject({
      isSellable: true,
      damagedLocationId: damagedId,
    });
    expect((await branches.findOne(tenantId, branchId)).damagedLocationId).toBe(
      damagedId,
    );
  });

  it('lets a warehouse point at the damaged-goods warehouse too', async () => {
    const updated = await warehouses.update(tenantId, sellableWarehouseId, {
      damagedLocationId: damagedId,
    });
    expect(updated.damagedLocationId).toBe(damagedId);
  });

  it('refuses a sellable location as the damaged-goods location', async () => {
    await expect(
      branches.update(tenantId, branchId, {
        damagedLocationId: sellableWarehouseId,
      }),
    ).rejects.toMatchObject(invalid);
    await expect(
      branches.create(tenantId, {
        name: 'CN lỗi',
        phoneNumber: phone,
        damagedLocationId: sellableWarehouseId,
      }),
    ).rejects.toMatchObject(invalid);
  });

  it('refuses a location naming itself', async () => {
    await expect(
      warehouses.update(tenantId, damagedId, { damagedLocationId: damagedId }),
    ).rejects.toMatchObject(invalid);
  });

  it('refuses another tenant’s damaged-goods warehouse', async () => {
    const foreign = await warehouses.create(otherTenantId, {
      name: 'Kho hỏng tenant khác',
      phoneNumber: phone,
      isSellable: false,
    });
    await expect(
      branches.update(tenantId, branchId, { damagedLocationId: foreign.id }),
    ).rejects.toMatchObject(invalid);
  });

  it('refuses a deleted damaged-goods warehouse', async () => {
    const old = await warehouses.create(tenantId, {
      name: 'Kho hỏng cũ',
      phoneNumber: phone,
      isSellable: false,
    });
    await warehouses.remove(tenantId, old.id);
    await expect(
      branches.update(tenantId, branchId, { damagedLocationId: old.id }),
    ).rejects.toMatchObject(invalid);
  });

  it('will not make the damaged-goods warehouse sellable while locations point at it', async () => {
    await expect(
      warehouses.update(tenantId, damagedId, { isSellable: true }),
    ).rejects.toMatchObject({
      response: {
        code: ErrorCode.LOCATION_DAMAGED_INVALID,
        message: expect.stringMatching(/Showroom.*Kho tổng|Kho tổng.*Showroom/),
      },
    });
    expect((await warehouses.findOne(tenantId, damagedId)).isSellable).toBe(
      false,
    );
  });

  it('clears the link with null, after which the warehouse can be made sellable', async () => {
    await branches.update(tenantId, branchId, { damagedLocationId: null });
    await warehouses.update(tenantId, sellableWarehouseId, {
      damagedLocationId: null,
    });
    expect(
      (await branches.findOne(tenantId, branchId)).damagedLocationId,
    ).toBeNull();

    const reopened = await warehouses.update(tenantId, damagedId, {
      isSellable: true,
    });
    expect(reopened.isSellable).toBe(true);
  });

  it('leaves the link alone when an update does not mention it', async () => {
    const damaged = await warehouses.create(tenantId, {
      name: 'Kho hỏng 2',
      phoneNumber: phone,
      isSellable: false,
    });
    await branches.update(tenantId, branchId, {
      damagedLocationId: damaged.id,
    });
    const renamed = await branches.update(tenantId, branchId, {
      name: 'Showroom mới',
    });
    expect(renamed).toMatchObject({
      name: 'Showroom mới',
      damagedLocationId: damaged.id,
    });
  });
});
