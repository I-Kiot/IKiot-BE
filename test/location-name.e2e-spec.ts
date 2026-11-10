import 'dotenv/config';
import { randomUUID } from 'crypto';
import { Test } from '@nestjs/testing';
import { PrismaModule } from './../src/prisma/prisma.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { SubscriptionService } from './../src/modules/subscriptions/subscriptions.service';
import { BranchService } from './../src/modules/branches/branches.service';
import { WarehouseService } from './../src/modules/warehouses/warehouses.service';
import { ErrorCode } from './../src/common/errors/error-codes';
import { LocationStatus } from './../src/common/constants/location-status';

/**
 * Tên chi nhánh / kho trên Postgres thật: không trùng trong cùng loại (không phân biệt hoa thường), chi nhánh và kho được trùng nhau, nơi đã xoá không tính. Hạn mức gói được bỏ qua; tự tạo một tenant riêng và dọn sạch.
 */
describe('Branch and warehouse names – LocationService', () => {
  let prisma: PrismaService;
  let branches: BranchService;
  let warehouses: WarehouseService;

  const tenantId = randomUUID();
  const phone = ['0900000000'];
  const taken = { response: { code: ErrorCode.LOCATION_NAME_TAKEN } };

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
      data: { id: tenantId, name: 'location-name-e2e' },
    });
    await branches.create(tenantId, { name: 'CN Hà Nội', phoneNumber: phone });
  });

  afterAll(async () => {
    await prisma.branch.deleteMany({ where: { tenantId } });
    await prisma.warehouse.deleteMany({ where: { tenantId } });
    await prisma.location.deleteMany({ where: { tenantId } });
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
    await prisma.$disconnect();
  });

  it('refuses a second branch with the same name, ignoring case and spaces', async () => {
    await expect(
      branches.create(tenantId, { name: 'CN Hà Nội', phoneNumber: phone }),
    ).rejects.toMatchObject(taken);
    await expect(
      branches.create(tenantId, { name: ' cn hÀ nỘi ', phoneNumber: phone }),
    ).rejects.toMatchObject(taken);
  });

  it('lets a warehouse use the name of a branch', async () => {
    const warehouse = await warehouses.create(tenantId, {
      name: 'CN Hà Nội',
      phoneNumber: phone,
    });
    expect(warehouse.name).toBe('CN Hà Nội');
  });

  it('refuses a second warehouse with the same name', async () => {
    await expect(
      warehouses.create(tenantId, { name: 'cn hà nội', phoneNumber: phone }),
    ).rejects.toMatchObject(taken);
  });

  it('refuses renaming a branch onto another branch, but keeps its own name', async () => {
    const other = await branches.create(tenantId, {
      name: 'CN HCM',
      phoneNumber: phone,
    });
    await expect(
      branches.update(tenantId, other.id, { name: 'CN Hà Nội' }),
    ).rejects.toMatchObject(taken);
    const same = await branches.update(tenantId, other.id, {
      name: 'CN HCM',
      address: '1 Lê Lợi',
    });
    expect(same.address).toBe('1 Lê Lợi');
  });

  it('frees the name of a deleted branch', async () => {
    const gone = await branches.create(tenantId, {
      name: 'CN Đà Nẵng',
      phoneNumber: phone,
    });
    await prisma.location.update({
      where: { id: gone.id },
      data: { status: LocationStatus.DELETED },
    });
    const again = await branches.create(tenantId, {
      name: 'CN Đà Nẵng',
      phoneNumber: phone,
    });
    expect(again.id).not.toBe(gone.id);
  });
});
