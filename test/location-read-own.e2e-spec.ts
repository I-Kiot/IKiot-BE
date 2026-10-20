import 'dotenv/config';
import { randomUUID } from 'crypto';
import { Test } from '@nestjs/testing';
import { PrismaModule } from './../src/prisma/prisma.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { SubscriptionService } from './../src/modules/subscriptions/subscriptions.service';
import { BranchService } from './../src/modules/branches/branches.service';
import { WarehouseService } from './../src/modules/warehouses/warehouses.service';
import { ErrorCode } from './../src/common/errors/error-codes';
import { SystemRole } from './../src/common/constants/system-role';
import type { AuthUser } from './../src/common/types/auth-user.type';

/**
 * Kiểm thử quyền nền `branches:read_own` / `warehouses:read_own` trên Postgres thật: nhân viên chỉ
 * thấy đúng nơi mình được phân công, `read` vẫn thấy cả shop. Hạn mức gói được bỏ qua
 * (SubscriptionService giả); tự tạo một tenant riêng và dọn sạch.
 */
describe('Reading your own posting – LocationService (read_own)', () => {
  let prisma: PrismaService;
  let branches: BranchService;
  let warehouses: WarehouseService;

  const tenantId = randomUUID();
  const phone = ['0900000000'];
  const page = { page: 1, limit: 20 };
  const notFound = { response: { code: ErrorCode.LOCATION_NOT_FOUND } };

  let postedBranchId = '';
  let otherBranchId = '';
  let warehouseId = '';

  /** Một tài khoản STAFF có các quyền cho trước, được phân công ở `posting`. */
  function staff(
    permissions: string[],
    posting: { branchId?: string; warehouseId?: string },
  ): AuthUser {
    return {
      userId: randomUUID(),
      tenantId,
      systemRole: SystemRole.STAFF,
      roleId: null,
      branchId: posting.branchId ?? null,
      warehouseId: posting.warehouseId ?? null,
      permissions: new Set(permissions),
      shiftSupervision: null,
      email: null,
      displayName: null,
      phoneNumber: '0900000000',
    };
  }

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

    await prisma.tenant.create({
      data: { id: tenantId, name: 'read-own-e2e' },
    });
    postedBranchId = (
      await branches.create(tenantId, { name: 'CN Hà Nội', phoneNumber: phone })
    ).id;
    otherBranchId = (
      await branches.create(tenantId, { name: 'CN HCM', phoneNumber: phone })
    ).id;
    warehouseId = (
      await warehouses.create(tenantId, {
        name: 'Kho tổng',
        phoneNumber: phone,
      })
    ).id;
  });

  afterAll(async () => {
    await prisma.branch.deleteMany({ where: { tenantId } });
    await prisma.warehouse.deleteMany({ where: { tenantId } });
    await prisma.location.deleteMany({ where: { tenantId } });
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
    await prisma.$disconnect();
  });

  it('lists only the branch a `read_own` employee is posted to', async () => {
    const user = staff(['branches:read_own'], { branchId: postedBranchId });
    const list = await branches.findAll(user, tenantId, page);
    expect(list.data.map((row) => row.id)).toEqual([postedBranchId]);
    expect(list.pagination.total).toBe(1);
  });

  it('opens their own branch and answers 404 for any other', async () => {
    const user = staff(['branches:read_own'], { branchId: postedBranchId });
    expect((await branches.findOne(user, tenantId, postedBranchId)).name).toBe(
      'CN Hà Nội',
    );
    await expect(
      branches.findOne(user, tenantId, otherBranchId),
    ).rejects.toMatchObject(notFound);
  });

  it('gives a branch employee an empty warehouse list', async () => {
    const user = staff(['warehouses:read_own'], { branchId: postedBranchId });
    const list = await warehouses.findAll(user, tenantId, page);
    expect(list.data).toEqual([]);
    expect(list.pagination.total).toBe(0);
    await expect(
      warehouses.findOne(user, tenantId, warehouseId),
    ).rejects.toMatchObject(notFound);
  });

  it('lets a warehouse employee read their own warehouse', async () => {
    const user = staff(['warehouses:read_own'], { warehouseId });
    const list = await warehouses.findAll(user, tenantId, page);
    expect(list.data.map((row) => row.id)).toEqual([warehouseId]);
  });

  it('still lists every branch for `read`', async () => {
    const user = staff(['branches:read', 'branches:read_own'], {
      branchId: postedBranchId,
    });
    const list = await branches.findAll(user, tenantId, page);
    expect(list.data.map((row) => row.id).sort()).toEqual(
      [postedBranchId, otherBranchId].sort(),
    );
  });
});
