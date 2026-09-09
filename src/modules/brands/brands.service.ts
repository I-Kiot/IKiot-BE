import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { paginate, skipFor } from '../../common/utils/pagination';
import { CreateBrandDto } from './dto/create-brand.dto';
import { UpdateBrandDto } from './dto/update-brand.dto';
import { QueryBrandDto } from './dto/query-brand.dto';
import type { Prisma } from '../../../generated/prisma/client';
import { ErrorCode } from '../../common/errors/error-codes';

/** Ported from BrandService, with two changes: brands are tenant-scoped now (the Mongoose model had no tenantId), and delete refuses while products still reference the brand instead of surfacing the FK error as a 500. */
@Injectable()
export class BrandService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(tenantId: string, query: QueryBrandDto) {
    const where: Prisma.BrandWhereInput = { tenantId };
    if (query.search) {
      where.name = { contains: query.search, mode: 'insensitive' };
    }

    const [data, total] = await Promise.all([
      this.prisma.brand.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: skipFor(query.page, query.limit),
        take: query.limit,
      }),
      this.prisma.brand.count({ where }),
    ]);

    return paginate(data, total, query.page, query.limit);
  }

  async findOne(tenantId: string, id: string) {
    const brand = await this.prisma.brand.findFirst({
      where: { id, tenantId },
    });
    if (!brand)
      throw new NotFoundException({
        code: ErrorCode.BRAND_NOT_FOUND,
        message: 'Brand not found',
      });
    return brand;
  }

  create(tenantId: string, dto: CreateBrandDto) {
    return this.prisma.brand.create({ data: { ...dto, tenantId } });
  }

  async update(tenantId: string, id: string, dto: UpdateBrandDto) {
    await this.findOne(tenantId, id);
    return this.prisma.brand.update({ where: { id }, data: dto });
  }

  async remove(tenantId: string, id: string) {
    await this.findOne(tenantId, id);

    const productCount = await this.prisma.product.count({
      where: { brandId: id },
    });
    if (productCount > 0) {
      throw new BadRequestException({
        code: ErrorCode.BRAND_IN_USE,
        message: `Cannot delete this brand: ${productCount} product(s) still use it`,
      });
    }

    return this.prisma.brand.delete({ where: { id } });
  }
}
