import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ErrorCode } from '../../common/errors/error-codes';
import type { AuthUser } from '../../common/types/auth-user.type';
import { can } from '../../common/utils/permission';
import { sameValues, valueMap } from './product-attributes';

export type AttributeChange = { attributeId: string; value: string };

export type ResolvedVariant = {
  productItemId: string;
  /** Vừa tạo SKU mới cho bộ thuộc tính này. */
  created: boolean;
};

/**
 * Tìm SKU đúng bộ thuộc tính khi đổi thuộc tính: giữ SKU gốc, dùng SKU anh em cùng bộ, hoặc tạo mới.
 * Đúng một SKU cho mỗi hàng làm ra, nếu không tồn kho lệch với kệ. `retailPrice` cần `products:update`.
 */
@Injectable()
export class ProductVariantService {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(
    user: AuthUser,
    tenantId: string,
    baseItemId: string,
    changes: AttributeChange[],
    retailPrice?: number,
  ): Promise<ResolvedVariant> {
    const base = await this.loadBase(tenantId, baseItemId);
    if (!base) {
      throw new NotFoundException({
        code: ErrorCode.PRODUCT_ITEM_NOT_FOUND,
        message: 'Product variant not found',
      });
    }

    const attributes = new Map(
      base.product.attributes.map((attr) => [attr.id, attr]),
    );
    const target = valueMap(base.details);
    for (const change of changes) {
      if (!attributes.has(change.attributeId)) {
        throw new BadRequestException({
          code: ErrorCode.PRODUCT_ATTRIBUTE_NOT_FOUND,
          message: 'The attribute is not on this product',
        });
      }
      const value = change.value.normalize('NFC').trim();
      if (!value) {
        throw new BadRequestException({
          code: ErrorCode.PRODUCT_ATTRIBUTE_VALUE_REQUIRED,
          message: 'An attribute value cannot be blank',
        });
      }
      target.set(change.attributeId, value);
    }

    let productItemId = base.id;
    let created = false;
    if (!sameValues(target, valueMap(base.details))) {
      const siblings = await this.prisma.productItem.findMany({
        where: {
          tenantId,
          productId: base.productId,
          itemType: base.itemType,
          id: { not: base.id },
        },
        select: {
          id: true,
          details: { select: { attributeId: true, value: true } },
        },
      });
      const match = siblings.find((item) =>
        sameValues(target, valueMap(item.details)),
      );
      if (match) {
        productItemId = match.id;
      } else {
        this.require(user, 'create');
        productItemId = await this.createVariant(
          base,
          target,
          attributes,
          retailPrice,
        );
        created = true;
      }
    }

    if (retailPrice !== undefined && !created) {
      this.require(user, 'update');
      await this.prisma.productItem.update({
        where: { id: productItemId },
        data: { retailPrice },
      });
    }
    return { productItemId, created };
  }

  private require(user: AuthUser, action: 'create' | 'update') {
    if (!can(user, 'products', action)) {
      throw new ForbiddenException({
        code: ErrorCode.PERMISSION_DENIED,
        message: `Missing permission products:${action}`,
      });
    }
  }

  private async createVariant(
    base: NonNullable<Awaited<ReturnType<typeof this.loadBase>>>,
    target: Map<string, string>,
    attributes: Map<string, { id: string; name: string; position: number }>,
    retailPrice: number | undefined,
  ): Promise<string> {
    const freeDetails = base.details.filter((detail) => !detail.attributeId);
    return this.prisma.$transaction(async (tx) => {
      // SKU = mã hàng = SKU gốc + "-V<n>", n là số nhỏ nhất chưa là SKU hay mã hàng của mặt hàng nào
      // (hai @@unique theo tenant là chốt chặn thật). Mã hàng từng chép nguyên của gốc - nay phải duy nhất.
      const stem = base.sku ?? base.productCode;
      const prefix = `${stem}-V`;
      const taken = await tx.productItem.findMany({
        where: {
          tenantId: base.tenantId,
          OR: [
            { sku: { startsWith: prefix } },
            { productCode: { startsWith: prefix } },
          ],
        },
        select: { sku: true, productCode: true },
      });
      const used = new Set(taken.flatMap((row) => [row.sku, row.productCode]));
      let n = 1;
      while (used.has(`${stem}-V${n}`)) n++;

      const item = await tx.productItem.create({
        data: {
          tenantId: base.tenantId,
          productId: base.productId,
          productName: base.productName,
          productCode: `${stem}-V${n}`,
          sku: `${stem}-V${n}`,
          description: base.description,
          retailPrice: retailPrice ?? base.retailPrice,
          costPrice: base.costPrice,
          productSlug: base.productSlug,
          warrantyPeriod: base.warrantyPeriod,
          vat: base.vat,
          itemType: base.itemType,
          allowCustomization: base.allowCustomization,
          customLeadTimeDays: base.customLeadTimeDays,
          lengthCm: base.lengthCm,
          widthCm: base.widthCm,
          heightCm: base.heightCm,
          weightKg: base.weightKg,
          volumeM3: base.volumeM3,
          images: {
            create: base.images.map(({ url, isThumbnail, position }) => ({
              url,
              isThumbnail,
              position,
            })),
          },
          suppliers: {
            create: base.suppliers.map(({ supplierId, leadTimeDays }) => ({
              supplierId,
              leadTimeDays,
            })),
          },
          packages: {
            create: base.packages.map(
              ({ position, name, lengthCm, widthCm, heightCm, weightKg }) => ({
                position,
                name,
                lengthCm,
                widthCm,
                heightCm,
                weightKg,
              }),
            ),
          },
          details: {
            create: [
              ...[...target].map(([attributeId, value]) => {
                const attr = attributes.get(attributeId)!;
                return {
                  attributeId,
                  name: attr.name,
                  value,
                  position: attr.position,
                };
              }),
              ...freeDetails.map(({ name, value, position }) => ({
                name,
                value,
                position,
              })),
            ],
          },
        },
        select: { id: true },
      });
      return item.id;
    });
  }

  private loadBase(tenantId: string, id: string) {
    return this.prisma.productItem.findFirst({
      where: { id, tenantId },
      include: {
        details: {
          select: {
            attributeId: true,
            name: true,
            value: true,
            position: true,
          },
        },
        images: { select: { url: true, isThumbnail: true, position: true } },
        suppliers: { select: { supplierId: true, leadTimeDays: true } },
        packages: true,
        product: {
          select: {
            attributes: {
              select: { id: true, name: true, position: true },
              orderBy: { position: 'asc' },
            },
          },
        },
      },
    });
  }
}
