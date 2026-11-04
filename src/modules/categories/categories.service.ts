import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { paginate, skipFor } from '../../common/utils/pagination';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { QueryCategoryDto } from './dto/query-category.dto';
import type { Category, Prisma } from '../../../generated/prisma/client';
import { ErrorCode } from '../../common/errors/error-codes';

// Chặn đi vòng vô hạn nếu dữ liệu xấu tạo ra chu kỳ cha-con; cùng giá trị với iKiotMS-BE.
const MAX_DEPTH = 20;

export interface CategoryNode extends Category {
  children: CategoryNode[];
}

/** Port từ CategoryService; như brands, category đã gắn theo tenant khi port. Phần xử lý cây, breadcrumb và vòng lặp được giữ nguyên cho bộ chọn của frontend. */
@Injectable()
export class CategoryService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(tenantId: string, query: QueryCategoryDto) {
    const where: Prisma.CategoryWhereInput = { tenantId };
    if (query.search) {
      where.name = { contains: query.search, mode: 'insensitive' };
    }
    if (query.parentId !== undefined) {
      where.parentId = query.parentId;
    }

    const [data, total] = await Promise.all([
      this.prisma.category.findMany({
        where,
        include: { parent: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'desc' },
        skip: skipFor(query.page, query.limit),
        take: query.limit,
      }),
      this.prisma.category.count({ where }),
    ]);

    return paginate(data, total, query.page, query.limit);
  }

  /** Lấy cả rừng danh mục trong một query rồi ghép trên bộ nhớ: cây nhỏ và được đọc liên tục, nên giữ một round trip thay vì CTE đệ quy. */
  async findTree(tenantId: string): Promise<CategoryNode[]> {
    const categories = await this.prisma.category.findMany({
      where: { tenantId },
      orderBy: { name: 'asc' },
    });

    const byId = new Map<string, CategoryNode>(
      categories.map((c) => [c.id, { ...c, children: [] }]),
    );

    const roots: CategoryNode[] = [];
    for (const category of categories) {
      const node = byId.get(category.id)!;
      const parent = category.parentId
        ? byId.get(category.parentId)
        : undefined;
      // Danh mục có cha bị thiếu (hoặc thuộc tenant khác) được đưa lên gốc thay vì bỏ đi, để lỗi dữ liệu không bao giờ làm mất sản phẩm khỏi bộ chọn.
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
    return roots;
  }

  private async findRow(tenantId: string, id: string): Promise<Category> {
    const category = await this.prisma.category.findFirst({
      where: { id, tenantId },
    });
    if (!category)
      throw new NotFoundException({
        code: ErrorCode.CATEGORY_NOT_FOUND,
        message: 'Category not found',
      });
    return category;
  }

  /** Mọi danh mục của tenant, key theo id. Các lần đi lên cha từng tốn một query mỗi cấp, và `findTree` đã chứng minh cả rừng vừa trong một query. */
  private async categoriesById(
    tenantId: string,
  ): Promise<Map<string, Category>> {
    const categories = await this.prisma.category.findMany({
      where: { tenantId },
    });
    return new Map(categories.map((category) => [category.id, category]));
  }

  /** Chuỗi từ `startFromId` lên tới gốc, gốc đứng đầu và gồm cả chính nó; dừng ở MAX_DEPTH để chu kỳ cha trong dữ liệu không quay vô hạn. */
  private ancestorsOf(
    byId: Map<string, Category>,
    startFromId: string | null,
  ): Category[] {
    const ancestors: Category[] = [];
    let cursor = startFromId;
    for (let depth = 0; cursor && depth < MAX_DEPTH; depth++) {
      const parent = byId.get(cursor);
      if (!parent) break;
      ancestors.unshift(parent);
      cursor = parent.parentId;
    }
    return ancestors;
  }

  /** Chi tiết kèm chuỗi tổ tiên, gốc đứng đầu, như API cũ trả về. */
  async findOne(tenantId: string, id: string) {
    const category = await this.prisma.category.findFirst({
      where: { id, tenantId },
      include: { parent: { select: { id: true, name: true } } },
    });
    if (!category)
      throw new NotFoundException({
        code: ErrorCode.CATEGORY_NOT_FOUND,
        message: 'Category not found',
      });

    const byId = await this.categoriesById(tenantId);
    const breadcrumbs = this.ancestorsOf(byId, category.parentId).map(
      (ancestor) => ({ id: ancestor.id, name: ancestor.name }),
    );

    return { ...category, breadcrumbs };
  }

  /** Cha phải tồn tại và cùng tenant, nếu không cây sẽ rò rỉ sang tenant khác. */
  private async assertParentExists(tenantId: string, parentId: string) {
    const parent = await this.prisma.category.findFirst({
      where: { id: parentId, tenantId },
    });
    if (!parent)
      throw new BadRequestException({
        code: ErrorCode.CATEGORY_PARENT_NOT_FOUND,
        message: 'The parent category does not exist',
      });
  }

  /** Từ chối gắn danh mục làm con của chính nó hoặc của con cháu nó, vì sẽ tách cây con khỏi mọi gốc. */
  private async assertNoCycle(
    tenantId: string,
    categoryId: string,
    newParentId: string,
  ) {
    if (categoryId === newParentId) {
      throw new BadRequestException({
        code: ErrorCode.CATEGORY_PARENT_SELF,
        message: 'A category cannot be its own parent',
      });
    }

    // Chuỗi tổ tiên mà danh mục sẽ có (kể cả cha đề xuất); nếu đi qua chính danh mục này thì việc chuyển sẽ tạo vòng lặp.
    const byId = await this.categoriesById(tenantId);
    const wouldBeAncestors = this.ancestorsOf(byId, newParentId);
    if (wouldBeAncestors.some((ancestor) => ancestor.id === categoryId)) {
      throw new BadRequestException({
        code: ErrorCode.CATEGORY_PARENT_CYCLE,
        message: 'A descendant category cannot be used as the parent',
      });
    }
  }

  async create(tenantId: string, dto: CreateCategoryDto) {
    if (dto.parentId) await this.assertParentExists(tenantId, dto.parentId);
    return this.prisma.category.create({ data: { ...dto, tenantId } });
  }

  async update(tenantId: string, id: string, dto: UpdateCategoryDto) {
    const existing = await this.findRow(tenantId, id);

    if (dto.parentId) {
      await this.assertParentExists(tenantId, dto.parentId);
      await this.assertNoCycle(tenantId, id, dto.parentId);
    }

    const renamed = dto.name !== undefined && dto.name !== existing.name;

    return this.prisma.$transaction(async (tx) => {
      const category = await tx.category.update({ where: { id }, data: dto });

      // `Product.categoryName` là bản sao phi chuẩn hoá cho màn danh sách, nên phải đổi theo khi đổi tên. iKiotMS-BE trước đây không làm, và mọi sản phẩm vẫn hiện tên cũ.
      if (renamed) {
        await tx.product.updateMany({
          where: { tenantId, categoryId: id },
          data: { categoryName: category.name },
        });
      }

      return category;
    });
  }

  async remove(tenantId: string, id: string) {
    await this.findRow(tenantId, id);

    // `Category.parentId` là onDelete: Restrict và `Product.categoryId` là FK thường; nếu không kiểm trước, cả hai sẽ thành lỗi ràng buộc không được xử lý.
    const [children, products] = await Promise.all([
      this.prisma.category.count({ where: { parentId: id } }),
      this.prisma.product.count({ where: { categoryId: id } }),
    ]);
    if (children > 0) {
      throw new BadRequestException({
        code: ErrorCode.CATEGORY_HAS_CHILDREN,
        message: `Cannot delete this category: it still has ${children} child categor(ies)`,
      });
    }
    if (products > 0) {
      throw new BadRequestException({
        code: ErrorCode.CATEGORY_IN_USE,
        message: `Cannot delete this category: ${products} product(s) still use it`,
      });
    }

    return this.prisma.category.delete({ where: { id } });
  }
}
