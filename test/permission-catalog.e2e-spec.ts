import 'dotenv/config';
import { randomUUID } from 'crypto';
import { Test } from '@nestjs/testing';
import { PrismaModule } from './../src/prisma/prisma.module';
import { PrismaService } from './../src/prisma/prisma.service';

/**
 * Danh mục quyền trên Postgres thật: `RolePermission` có khoá ngoại vào `permission_catalog`, nên quyền không có dòng trong danh mục thì không gán được cho role nào. Deploy chỉ chạy `prisma migrate deploy`, không chạy seed, nên quyền thêm vào seed sau này phải có migration; ba quyền dưới đây từng bị sót. Tự tạo một tenant riêng và dọn sạch.
 */
describe('Permission catalog – pairs added after the first seed', () => {
  let prisma: PrismaService;

  const tenantId = randomUUID();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    await prisma.tenant.create({
      data: { id: tenantId, name: 'permission-catalog-e2e' },
    });
  });

  afterAll(async () => {
    await prisma.rolePermission.deleteMany({ where: { role: { tenantId } } });
    await prisma.role.deleteMany({ where: { tenantId } });
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
    await prisma.$disconnect();
  });

  it.each([
    ['production', 'deliver'],
    ['branches', 'read_own'],
    ['warehouses', 'read_own'],
  ])('lets a role hold %s:%s', async (resource, action) => {
    const role = await prisma.role.create({
      data: { tenantId, name: `role-${resource}-${action}` },
    });
    const granted = await prisma.rolePermission.create({
      data: { roleId: role.id, resource, action },
    });
    expect(granted).toMatchObject({ resource, action });
  });
});
