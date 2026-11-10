import 'dotenv/config';
import { randomUUID } from 'crypto';
import { Test } from '@nestjs/testing';
import { PrismaModule } from './../src/prisma/prisma.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { CategoryService } from './../src/modules/categories/categories.service';
import { ErrorCode } from './../src/common/errors/error-codes';

/**
 * Tên danh mục trên Postgres thật: hai danh mục cùng cha không được trùng tên (không phân biệt hoa thường), khác cha thì được. Tự tạo một tenant riêng và dọn sạch.
 */
describe('Category names – CategoryService', () => {
  let prisma: PrismaService;
  let categories: CategoryService;

  const tenantId = randomUUID();
  const taken = { response: { code: ErrorCode.CATEGORY_NAME_TAKEN } };

  let parentAId = '';
  let parentBId = '';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [CategoryService],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    categories = moduleRef.get(CategoryService);

    await prisma.tenant.create({
      data: { id: tenantId, name: 'category-name-e2e' },
    });
    parentAId = (await categories.create(tenantId, { name: 'Bàn' })).id;
    parentBId = (await categories.create(tenantId, { name: 'Ghế' })).id;
  });

  afterAll(async () => {
    await prisma.category.deleteMany({
      where: { tenantId, parentId: { not: null } },
    });
    await prisma.category.deleteMany({ where: { tenantId } });
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
    await prisma.$disconnect();
  });

  it('refuses a second root category with the same name', async () => {
    await expect(
      categories.create(tenantId, { name: 'Bàn' }),
    ).rejects.toMatchObject(taken);
  });

  it('compares names ignoring case and surrounding spaces', async () => {
    await expect(
      categories.create(tenantId, { name: '  bÀN ' }),
    ).rejects.toMatchObject(taken);
  });

  it('stores the trimmed name', async () => {
    const created = await categories.create(tenantId, { name: '  Tủ  ' });
    expect(created.name).toBe('Tủ');
  });

  it('allows the same name under different parents', async () => {
    const underA = await categories.create(tenantId, {
      name: 'Khác',
      parentId: parentAId,
    });
    const underB = await categories.create(tenantId, {
      name: 'Khác',
      parentId: parentBId,
    });
    expect(underA.id).not.toBe(underB.id);
  });

  it('refuses the same name twice under one parent', async () => {
    await expect(
      categories.create(tenantId, { name: 'khác', parentId: parentAId }),
    ).rejects.toMatchObject(taken);
  });

  it('refuses renaming onto a sibling name, but lets a category keep its own name', async () => {
    const draft = await categories.create(tenantId, { name: 'Giường' });
    await expect(
      categories.update(tenantId, draft.id, { name: 'Bàn' }),
    ).rejects.toMatchObject(taken);
    const same = await categories.update(tenantId, draft.id, {
      name: 'Giường',
      description: 'còn nguyên tên cũ',
    });
    expect(same.description).toBe('còn nguyên tên cũ');
  });

  it('refuses moving a category under a parent that already has that name', async () => {
    const moving = await categories.create(tenantId, { name: 'Khác' });
    await expect(
      categories.update(tenantId, moving.id, { parentId: parentAId }),
    ).rejects.toMatchObject(taken);
    const moved = await categories.update(tenantId, moving.id, {
      name: 'Loại khác',
      parentId: parentAId,
    });
    expect(moved.parentId).toBe(parentAId);
  });
});
