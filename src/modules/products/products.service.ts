import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { flattenCombo, type ComboLeaf } from '../orders/combo-expansion';
import { loadComboGraph } from '../orders/order-combo';
import { comboSetsAvailable, shelfOf } from './combo-availability';
import { SubscriptionService } from '../subscriptions/subscriptions.service';
import {
  LOCATION_SELECT,
  locationMatcher,
} from '../../common/dto/location-ref.dto';
import type {
  LocationRef,
  LocationRefQueryDto,
} from '../../common/dto/location-ref.dto';
import {
  ProductItemType,
  ProductStatus,
  ProductType,
  QUOTA_COUNTED_PRODUCT_STATUSES,
  itemTypeFor,
} from '../../common/constants/product-status';
import {
  assertComponentsMatchType,
  assertNoDiscontinuedComponent,
  lockComboGraph,
  recomputeComboCosts,
  writeComboComponents,
} from './combo-components';
import { paginate, skipFor } from '../../common/utils/pagination';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { CreateProductItemDto } from './dto/product-item.dto';
import { UpdateProductItemDto } from './dto/update-product-item.dto';
import {
  QueryProductDto,
  QueryProductItemDto,
  SearchProductDto,
} from './dto/query-product.dto';
import { OPEN_MOVEMENT_STATUSES } from '../stock-movement-requests/stock-movement.constants';
import type { Prisma } from '../../../generated/prisma/client';
import { ErrorCode } from '../../common/errors/error-codes';
import { LocationType } from '../../common/constants/location-type';
import {
  replaceAttributes,
  upsertAttributeUnits,
  writeItemDetails,
} from './product-attributes';

/** Prefix of auto-allocated product codes (`SP000001`, ...). */
const CODE_PREFIX = 'SP';

/** A variant DTO once `allocateItemCodes` has filled in the two codes. */
type ItemWithCodes = CreateProductItemDto & {
  productCode: string;
  sku: string;
};

const IMAGES_INCLUDE = {
  select: { id: true, url: true, isThumbnail: true, position: true },
  orderBy: { position: 'asc' },
} as const;

/** Đủ để chọn một ảnh nhỏ cho một phiên bản: ảnh của nó, không có thì ảnh của hàng hoá. */
const THUMBNAIL_SELECT = {
  images: {
    select: { url: true, isThumbnail: true },
    orderBy: { position: 'asc' },
  },
  product: {
    select: {
      images: {
        select: { url: true, isThumbnail: true },
        orderBy: { position: 'asc' },
      },
    },
  },
} as const satisfies Prisma.ProductItemSelect;

type ThumbnailSource = Prisma.ProductItemGetPayload<{
  select: typeof THUMBNAIL_SELECT;
}>;

/** Ảnh đại diện (isThumbnail) trước, rồi ảnh đầu tiên; phiên bản không có ảnh nào thì dùng ảnh hàng hoá. */
function thumbnailOf({ images, product }: ThumbnailSource): string | null {
  const pick = (list: { url: string; isThumbnail: boolean }[]) =>
    (list.find((image) => image.isThumbnail) ?? list[0])?.url;
  return pick(images) ?? pick(product.images) ?? null;
}

const ITEM_INCLUDE = {
  images: IMAGES_INCLUDE,
  details: {
    select: {
      id: true,
      attributeId: true,
      name: true,
      value: true,
      position: true,
    },
    orderBy: { position: 'asc' },
  },
  suppliers: {
    select: {
      supplier: {
        select: {
          id: true,
          supplierName: true,
          email: true,
          phoneNumber: true,
        },
      },
    },
  },
  // Một tầng: thành phần là combo thì FE mở tiếp bằng GET /products/:productId của nó.
  // Thứ tự cố định theo SKU: mỗi lần lưu là xoá rồi ghi lại, bảng không có cột vị trí nên không giữ được thứ tự nhập.
  comboComponents: {
    orderBy: [{ componentItem: { sku: 'asc' } }, { componentItemId: 'asc' }],
    select: {
      quantity: true,
      componentItem: {
        select: {
          id: true,
          productId: true,
          sku: true,
          productName: true,
          itemType: true,
          retailPrice: true,
          costPrice: true,
          ...THUMBNAIL_SELECT,
        },
      },
    },
  },
} as const satisfies Prisma.ProductItemInclude;

type ItemRow = Prisma.ProductItemGetPayload<{ include: typeof ITEM_INCLUDE }>;

/** One location's share of a variant's stock. */
export interface StockDetail {
  inventoryId: string;
  stock: number;
  location: LocationRef;
}

/**
 * A variant's stock read two ways at once, which is what a location-scoped screen needs.
 *
 * `details` is only the location being viewed - the branch's own shelf, the field
 * `stockDetails` has always meant. `allLocations` is the same variant everywhere in the
 * chain, so a branch holding none of something can still say how many the shop has and
 * whether it is worth requesting a transfer.
 */
interface ItemStock {
  details: StockDetail[];
  allLocations: number;
  /** What a sale may take at the viewed location(s): `stock − lockedStock` per row, floored at 0. `stock` above is the total on hand, packed goods included. */
  available: number;
  /** The same, over every location. */
  availableAllLocations: number;
  /** Only for a COMBO, which has no rows of its own: how many whole sets its components' shelves cover (`comboSetsAvailable`). Replaces the figures above when present. */
  sets?: { here: number; allLocations: number };
}

/** Real port of ProductService: a Product is the catalogue entry, a ProductItem the sellable variant carrying price, SKU and stock. Three deliberate fixes - a subscription is now required to create anything (the old body was wrapped in `if (subscription)` and returned 200 having created nothing), `categoryName` is derived rather than accepted, and deleting a variant checks every table that references it, since those references are real foreign keys now. */
@Injectable()
export class ProductService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptions: SubscriptionService,
  ) {}

  // ─── Products ──────────────────────────────────────────────────────────────

  async create(tenantId: string, dto: CreateProductDto) {
    await this.subscriptions.assertQuota(
      tenantId,
      'quotaSnapshotMaxProducts',
      () =>
        this.prisma.product.count({
          where: {
            tenantId,
            status: { in: [...QUOTA_COUNTED_PRODUCT_STATUSES] },
          },
        }),
      'products',
    );

    const items = await this.allocateItemCodes(tenantId, dto.items);
    this.assertNoDuplicateSkusInPayload(items);
    await this.assertSkusAreFree(
      tenantId,
      items.map((item) => item.sku),
    );
    const categoryName = await this.resolveCategoryName(
      tenantId,
      dto.categoryId,
    );
    await this.assertBrandExists(tenantId, dto.brandId);
    await this.assertItemReferencesExist(tenantId, dto.items);
    const productType = dto.productType ?? ProductType.PRODUCT;

    const productId = await this.prisma.$transaction(async (tx) => {
      const product = await tx.product.create({
        data: {
          tenantId,
          name: dto.name,
          brandId: dto.brandId,
          categoryId: dto.categoryId,
          categoryName,
          status: dto.status ?? ProductStatus.ACTIVE,
          isManufacturable: dto.isManufacturable ?? false,
          productType,
          images: { create: this.imageRows(dto.images) },
        },
        select: { id: true },
      });

      // Thuộc tính (kèm đơn vị) tạo trước, để giá trị của SKU đầu tiên nối đúng vào chúng.
      if (dto.attributes) {
        await upsertAttributeUnits(tx, tenantId, product.id, dto.attributes);
      }
      for (const item of items) {
        await this.insertItem(tx, tenantId, product.id, productType, item);
      }

      return product.id;
    });

    return this.findOne(tenantId, productId, {});
  }

  async findAll(tenantId: string, query: QueryProductDto) {
    const where = this.buildProductWhere(tenantId, query);
    if (query.search) {
      where.name = { contains: query.search, mode: 'insensitive' };
    }

    const [rows, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        include: {
          brand: { select: { id: true, name: true } },
          images: IMAGES_INCLUDE,
        },
        orderBy: { createdAt: 'desc' },
        skip: skipFor(query.page, query.limit),
        take: query.limit,
      }),
      this.prisma.product.count({ where }),
    ]);

    // Deliberately no `items` here: a product list is a table of products, and attaching every variant made the payload several times larger. Callers needing variants use /products/search or /products/items.
    const totals = await this.totalStockByProduct(
      tenantId,
      rows.map((row) => row.id),
      query,
    );
    // A combo product has no inventory rows of its own, so the query above reads 0 for it. Its total is the sets its variants cover (`stockWithCombos`), summed like any other product's variants.
    const comboSets = await this.comboProductTotals(
      tenantId,
      rows
        .filter((row) => row.productType === ProductType.COMBO)
        .map((row) => row.id),
      query,
    );
    for (const [productId, total] of comboSets) totals.set(productId, total);

    const data = rows.map(({ brand, ...product }) => {
      const total = totals.get(product.id);
      return {
        ...product,
        brandName: brand?.name ?? null,
        totalStock: total?.here ?? 0,
        totalStockAllLocations: total?.allLocations ?? 0,
      };
    });

    return paginate(data, total, query.page, query.limit);
  }

  /** The POS lookup: one term matched against the product name anywhere and against every variant's code, SKU and barcode as a prefix, with the variants returned inline so a specific SKU can be picked straight out. */
  async search(tenantId: string, query: SearchProductDto) {
    const where = this.buildProductWhere(tenantId, query);
    if (query.q) {
      const prefix = { startsWith: query.q, mode: 'insensitive' } as const;
      where.OR = [
        { name: { contains: query.q, mode: 'insensitive' } },
        {
          productItems: {
            some: {
              OR: [
                { productCode: prefix },
                { sku: prefix },
                { barcode: prefix },
              ],
            },
          },
        },
      ];
    }

    const [rows, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        include: {
          brand: { select: { id: true, name: true } },
          images: IMAGES_INCLUDE,
        },
        orderBy: { createdAt: 'desc' },
        skip: skipFor(query.page, query.limit),
        take: query.limit,
      }),
      this.prisma.product.count({ where }),
    ]);

    const items = await this.prisma.productItem.findMany({
      where: { tenantId, productId: { in: rows.map((row) => row.id) } },
      include: ITEM_INCLUDE,
    });
    const stock = await this.stockWithCombos(
      tenantId,
      this.withComponentCombos(items),
      query,
    );

    const data = rows.map(({ brand, ...product }) => {
      const own = items
        .filter((item) => item.productId === product.id)
        .map((item) => this.toItemResponse(item, stock.get(item.id), stock));
      return {
        ...product,
        brandName: brand?.name ?? null,
        items: own,
        totalStock: own.reduce((sum, item) => sum + item.stock, 0),
        totalStockAllLocations: own.reduce(
          (sum, item) => sum + item.stockAllLocations,
          0,
        ),
      };
    });

    return paginate(data, total, query.page, query.limit);
  }

  /**
   * Flat list of variants for pickers that reference a specific SKU; capped rather than
   * paginated, because it feeds a dropdown.
   *
   * `branchIds` **attaches** each variant's stock at those branches, it does not filter by
   * it. Filtering was the old behaviour and it hid the catalogue from the screens that need
   * it most: a promotion for goods arriving next week, or a transfer request for something
   * the branch has never carried, both start from a variant with no row there. A picker's
   * job is to show what the shop sells and say how many are where - `stock: 0` answers
   * that; an absent option does not.
   */
  async listItems(tenantId: string, query: QueryProductItemDto) {
    const where: Prisma.ProductItemWhereInput = { tenantId };

    if (query.search) {
      const match = { contains: query.search, mode: 'insensitive' } as const;
      where.OR = [
        { sku: match },
        { productName: match },
        { productCode: match },
      ];
    }
    if (query.excludeDiscontinued || query.productType?.length) {
      where.product = {
        ...(query.excludeDiscontinued && {
          status: { not: ProductStatus.DISCONTINUED },
        }),
        ...(query.productType?.length && {
          productType: { in: query.productType },
        }),
      };
    }

    const found = await this.prisma.productItem.findMany({
      where,
      select: {
        id: true,
        productId: true,
        productName: true,
        productCode: true,
        sku: true,
        itemType: true,
        costPrice: true,
        ...THUMBNAIL_SELECT,
      },
      orderBy: { productName: 'asc' },
      take: query.limit,
    });
    const items = found.map(({ images, product, costPrice, ...item }) => ({
      ...item,
      costPrice: Number(costPrice),
      thumbnailUrl: thumbnailOf({ images, product }),
    }));

    if (!query.branchIds?.length || items.length === 0) return items;

    const rows = await this.prisma.inventory.groupBy({
      by: ['productItemId'],
      where: {
        tenantId,
        // Branch ids are Location ids; the kind filter keeps a warehouse id from counting as a branch.
        locationId: { in: query.branchIds },
        location: { type: LocationType.BRANCH },
        productItemId: { in: items.map((item) => item.id) },
      },
      _sum: { stock: true },
    });
    const stockByItem = new Map(
      rows.map((row) => [row.productItemId, row._sum.stock ?? 0]),
    );

    return items.map((item) => ({
      ...item,
      stock: stockByItem.get(item.id) ?? 0,
    }));
  }

  /** Detail: the product, every variant, and where each variant's stock sits. */
  async findOne(tenantId: string, id: string, location: LocationRefQueryDto) {
    const product = await this.prisma.product.findFirst({
      where: { id, tenantId },
      include: {
        brand: { select: { id: true, name: true } },
        category: { select: { id: true, name: true } },
        images: IMAGES_INCLUDE,
        attributes: {
          select: { id: true, name: true, unit: true, position: true },
          orderBy: { position: 'asc' },
        },
      },
    });
    if (!product)
      throw new NotFoundException({
        code: ErrorCode.PRODUCT_NOT_FOUND,
        message: 'Product not found',
      });

    const items = await this.prisma.productItem.findMany({
      where: { productId: id, tenantId },
      include: ITEM_INCLUDE,
      orderBy: { createdAt: 'asc' },
    });
    const stock = await this.stockWithCombos(
      tenantId,
      this.withComponentCombos(items),
      location,
    );

    const { brand, ...rest } = product;
    const mapped = items.map((item) =>
      this.toItemResponse(item, stock.get(item.id), stock),
    );

    return {
      ...rest,
      brandName: brand?.name ?? null,
      items: mapped,
      totalStock: mapped.reduce((sum, item) => sum + item.stock, 0),
      totalStockAllLocations: mapped.reduce(
        (sum, item) => sum + item.stockAllLocations,
        0,
      ),
    };
  }

  async update(tenantId: string, id: string, dto: UpdateProductDto) {
    // Prisma's update({ where: { id } }) can't take a non-unique tenant filter, so scope has to be re-checked first or any tenant could write any row by id.
    const existing = await this.prisma.product.findFirst({
      where: { id, tenantId },
      select: { id: true },
    });
    if (!existing)
      throw new NotFoundException({
        code: ErrorCode.PRODUCT_NOT_FOUND,
        message: 'Product not found',
      });

    await this.assertBrandExists(tenantId, dto.brandId);
    const categoryName =
      dto.categoryId === undefined
        ? undefined
        : await this.resolveCategoryName(tenantId, dto.categoryId);

    await this.prisma.$transaction(async (tx) => {
      // Ngừng bán combo thì các món của nó được phép ngừng theo (`discontinue` không tính combo đã
      // ngừng), nên bật combo lại phải kiểm lại. Trạng thái đọc lại sau khoá: đọc trước đó thì một
      // `discontinue` chen vào giữa làm lệnh này bật combo lên mà không qua kiểm tra.
      if (
        dto.status !== undefined &&
        dto.status !== ProductStatus.DISCONTINUED
      ) {
        await lockComboGraph(tx, tenantId);
        const current = await tx.product.findUniqueOrThrow({
          where: { id },
          select: { status: true },
        });
        if (current.status === ProductStatus.DISCONTINUED) {
          await this.assertCombosSellable(tx, tenantId, id);
        }
      }
      await tx.product.update({
        where: { id },
        data: {
          name: dto.name,
          brandId: dto.brandId,
          categoryId: dto.categoryId,
          categoryName,
          status: dto.status,
          isManufacturable: dto.isManufacturable,
        },
      });

      if (dto.attributes) {
        await replaceAttributes(tx, tenantId, id, dto.attributes);
      }

      if (dto.images) {
        await tx.productImage.deleteMany({ where: { productId: id } });
        await tx.productImage.createMany({
          data: this.imageRows(dto.images).map((image) => ({
            ...image,
            productId: id,
          })),
        });
      }

      // ProductItem.productName is a denormalized copy of the product's name, so it has to follow a rename.
      if (dto.name) {
        await tx.productItem.updateMany({
          where: { productId: id, tenantId },
          data: { productName: dto.name },
        });
      }
    });

    return this.findOne(tenantId, id, {});
  }

  /** Thêm một thuộc tính (đứng cuối); trùng tên (không phân biệt hoa thường) thì trả thuộc tính đã có, chỉ cập nhật đơn vị nếu vừa gửi. */
  async addAttribute(
    tenantId: string,
    productId: string,
    dto: { name: string; unit?: string },
  ) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, tenantId },
      select: {
        id: true,
        attributes: { select: { id: true, name: true, position: true } },
      },
    });
    if (!product)
      throw new NotFoundException({
        code: ErrorCode.PRODUCT_NOT_FOUND,
        message: 'Product not found',
      });
    const name = dto.name.normalize('NFC').trim();
    const unit = dto.unit?.trim() || null;
    const select = {
      id: true,
      name: true,
      unit: true,
      position: true,
    } as const;
    const same = product.attributes.find(
      (attr) =>
        attr.name.toLocaleLowerCase('vi') === name.toLocaleLowerCase('vi'),
    );
    if (same) {
      return unit
        ? this.prisma.productAttribute.update({
            where: { id: same.id },
            data: { unit },
            select,
          })
        : this.prisma.productAttribute.findUniqueOrThrow({
            where: { id: same.id },
            select,
          });
    }
    const position = product.attributes.reduce(
      (max, attr) => Math.max(max, attr.position + 1),
      0,
    );
    return this.prisma.productAttribute.create({
      data: { tenantId, productId, name, unit, position },
      select,
    });
  }

  /** Soft delete to DISCONTINUED - order items, stock movements and inventory all hold a foreign key to this product's variants - refused while stock, an unfinished transfer or an unpaid order still makes the product live. */
  async discontinue(tenantId: string, id: string) {
    const product = await this.prisma.product.findFirst({
      where: { id, tenantId },
      select: { id: true, status: true },
    });
    if (!product)
      throw new NotFoundException({
        code: ErrorCode.PRODUCT_NOT_FOUND,
        message: 'Product not found',
      });
    if (product.status === ProductStatus.DISCONTINUED) {
      throw new BadRequestException({
        code: ErrorCode.PRODUCT_DISCONTINUED,
        message: 'This product has been discontinued',
      });
    }

    const itemIds = (
      await this.prisma.productItem.findMany({
        where: { productId: id, tenantId },
        select: { id: true },
      })
    ).map((item) => item.id);

    if (itemIds.length > 0) {
      const [stocked, movements, orders] = await Promise.all([
        this.prisma.inventory.count({
          where: { tenantId, productItemId: { in: itemIds }, stock: { gt: 0 } },
        }),
        this.prisma.stockMovementRequest.count({
          where: {
            tenantId,
            status: { in: [...OPEN_MOVEMENT_STATUSES] },
            // The relation is `details` on StockMovementRequest, `items` on Order.
            details: { some: { productItemId: { in: itemIds } } },
          },
        }),
        this.prisma.order.count({
          where: {
            tenantId,
            status: 'PENDING',
            items: { some: { productItemId: { in: itemIds } } },
          },
        }),
      ]);

      if (stocked > 0) {
        throw new BadRequestException({
          code: ErrorCode.PRODUCT_HAS_STOCK,
          message: 'Cannot discontinue: the product still has stock.',
        });
      }
      if (movements > 0) {
        throw new BadRequestException({
          code: ErrorCode.PRODUCT_IN_STOCK_MOVEMENT,
          message:
            'Cannot discontinue: the product is on an unfinished stock movement.',
        });
      }
      if (orders > 0) {
        throw new BadRequestException({
          code: ErrorCode.PRODUCT_IN_UNPAID_ORDER,
          message: 'Cannot discontinue: the product is on an unpaid order.',
        });
      }
    }

    // Kiểm combo và ghi trạng thái dưới cùng khoá với việc sửa thành phần / bật lại combo: kiểm ngoài
    // transaction thì một combo vừa thêm món này (chưa commit) không được đếm, rồi cả hai cùng commit.
    await this.prisma.$transaction(async (tx) => {
      await lockComboGraph(tx, tenantId);
      // Combo của sản phẩm khác còn bán mà chứa SKU của sản phẩm này: ngừng nó thì combo bán ra món đã ngừng.
      const combos = await tx.comboComponent.count({
        where: {
          componentItem: { productId: id },
          comboItem: {
            productId: { not: id },
            product: { status: { not: ProductStatus.DISCONTINUED } },
          },
        },
      });
      if (combos > 0) {
        throw new BadRequestException({
          code: ErrorCode.PRODUCT_ITEM_IN_COMBO,
          message:
            'Cannot discontinue: a variant is a component of a combo that is still sold.',
        });
      }
      await tx.product.update({
        where: { id },
        data: { status: ProductStatus.DISCONTINUED },
      });
    });
    return this.findOne(tenantId, id, {});
  }

  // ─── Variants ──────────────────────────────────────────────────────────────

  async createItem(
    tenantId: string,
    productId: string,
    dto: CreateProductItemDto,
  ) {
    // The old route sat behind requireActiveSubscription: adding a variant doesn't consume the product quota, but it is still a write to the catalogue.
    await this.subscriptions.requireActiveSubscription(tenantId);

    const product = await this.prisma.product.findFirst({
      where: { id: productId, tenantId },
      select: { id: true, productType: true },
    });
    if (!product)
      throw new NotFoundException({
        code: ErrorCode.PRODUCT_NOT_FOUND,
        message: 'Product not found',
      });

    const [item] = await this.allocateItemCodes(tenantId, [dto]);
    await this.assertSkusAreFree(tenantId, [item.sku]);
    await this.assertItemReferencesExist(tenantId, [item]);

    const itemId = await this.prisma.$transaction((tx) =>
      this.insertItem(
        tx,
        tenantId,
        productId,
        product.productType as ProductType,
        item,
      ),
    );

    return this.findItem(tenantId, itemId);
  }

  async updateItem(
    tenantId: string,
    itemId: string,
    dto: UpdateProductItemDto,
  ) {
    const existing = await this.prisma.productItem.findFirst({
      where: { id: itemId, tenantId },
      select: { id: true, productId: true, itemType: true },
    });
    if (!existing)
      throw new NotFoundException({
        code: ErrorCode.PRODUCT_ITEM_NOT_FOUND,
        message: 'Product item not found',
      });

    if (dto.sku) await this.assertSkusAreFree(tenantId, [dto.sku], itemId);
    if (dto.comboComponents) {
      assertComponentsMatchType(existing.itemType, dto.comboComponents);
    }
    // Một danh sách rỗng gửi kèm cho hàng thường nghĩa là "không có thành phần" - bỏ qua, không ghi.
    const writeComponents =
      existing.itemType === ProductItemType.COMBO && dto.comboComponents;

    await this.prisma.$transaction(async (tx) => {
      await tx.productItem.update({
        where: { id: itemId },
        data: {
          productName: dto.productName,
          productCode: dto.productCode,
          sku: dto.sku,
          barcode: dto.barcode,
          description: dto.description,
          retailPrice: dto.retailPrice,
          // A combo's cost is the sum of its components', written by `writeComboComponents`.
          costPrice:
            existing.itemType === ProductItemType.COMBO
              ? undefined
              : dto.costPrice,
          warrantyPeriod: dto.warrantyPeriod,
          vat: dto.vat,
        },
      });
      // Combos above this variant carry a cost derived from it - re-price them.
      if (
        existing.itemType !== ProductItemType.COMBO &&
        dto.costPrice !== undefined
      ) {
        await recomputeComboCosts(tx, tenantId, [itemId]);
      }

      // Both collections are replaced wholesale when present, same as the old API: the client sends the list it wants to end up with, not a patch of it.
      if (dto.images) {
        await tx.productItemImage.deleteMany({
          where: { productItemId: itemId },
        });
        await tx.productItemImage.createMany({
          data: this.imageRows(dto.images).map((image) => ({
            ...image,
            productItemId: itemId,
          })),
        });
      }
      if (dto.productDetails) {
        await writeItemDetails(
          tx,
          tenantId,
          existing.productId,
          itemId,
          dto.productDetails,
        );
      }
      // Đơn đã bán giữ các dòng con đã bung lúc bán; sửa thành phần chỉ áp cho đơn sau.
      if (writeComponents) {
        await writeComboComponents(tx, tenantId, itemId, writeComponents);
      }
    });

    return this.findItem(tenantId, itemId);
  }

  /** Hard delete of a variant, refused while anything still points at it - the old service checked inventory only, and the other three references are real foreign keys here. */
  async removeItem(tenantId: string, itemId: string) {
    const item = await this.prisma.productItem.findFirst({
      where: { id: itemId, tenantId },
      select: { id: true },
    });
    if (!item)
      throw new NotFoundException({
        code: ErrorCode.PRODUCT_ITEM_NOT_FOUND,
        message: 'Product item not found',
      });

    const [inventories, movements, orders, promotions, combos] =
      await Promise.all([
        this.prisma.inventory.count({ where: { productItemId: itemId } }),
        this.prisma.stockMovementRequestItem.count({
          where: { productItemId: itemId },
        }),
        this.prisma.orderItem.count({ where: { productItemId: itemId } }),
        this.prisma.promotionProductItem.count({
          where: { productItemId: itemId },
        }),
        this.prisma.comboComponent.count({
          where: { componentItemId: itemId },
        }),
      ]);

    if (inventories > 0) {
      throw new BadRequestException({
        code: ErrorCode.PRODUCT_ITEM_AT_LOCATION,
        message:
          'Cannot delete this item while it is still assigned to one or more locations. Remove it from all of them first.',
      });
    }
    if (movements > 0 || orders > 0) {
      throw new BadRequestException({
        code: ErrorCode.PRODUCT_ITEM_HAS_TRANSACTIONS,
        message:
          'Cannot delete this item because orders or stock movements exist for it. Discontinue the product instead.',
      });
    }
    if (promotions > 0) {
      throw new BadRequestException({
        code: ErrorCode.PRODUCT_ITEM_IN_PROMOTION,
        message: 'Cannot delete this item because it belongs to a promotion.',
      });
    }
    // Không có cascade ở phía thành phần (FK chặn), nên báo rõ thay vì để lỗi FK.
    if (combos > 0) {
      throw new BadRequestException({
        code: ErrorCode.PRODUCT_ITEM_IN_COMBO,
        message:
          'Cannot delete this item because it is a component of a combo. Remove it from the combo first.',
      });
    }

    // Images, details and supplier links cascade from the schema.
    await this.prisma.productItem.delete({ where: { id: itemId } });
    return { id: itemId, deleted: true };
  }

  /** Idempotent, like the old `$addToSet`: attaching the same supplier twice is a no-op. */
  async addSupplierToItem(
    tenantId: string,
    itemId: string,
    supplierId: string,
  ) {
    const [item, supplier] = await Promise.all([
      this.prisma.productItem.findFirst({
        where: { id: itemId, tenantId },
        select: { id: true },
      }),
      this.prisma.supplier.findFirst({
        where: { id: supplierId, tenantId },
        select: { id: true },
      }),
    ]);
    if (!item)
      throw new NotFoundException({
        code: ErrorCode.PRODUCT_ITEM_NOT_FOUND,
        message: 'Product item not found',
      });
    if (!supplier)
      throw new NotFoundException({
        code: ErrorCode.SUPPLIER_NOT_FOUND,
        message: 'Supplier not found',
      });

    await this.prisma.productItemSupplier.upsert({
      where: {
        productItemId_supplierId: { productItemId: itemId, supplierId },
      },
      create: { productItemId: itemId, supplierId },
      update: {},
    });

    return this.findItem(tenantId, itemId);
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  /**
   * The combos of `productId` may be sold again only if none of their components belongs to a
   * discontinued product. Components that are variants of `productId` itself are skipped: they come
   * back on with it (`discontinue` skips them for the same reason).
   */
  private async assertCombosSellable(
    tx: Prisma.TransactionClient,
    tenantId: string,
    productId: string,
  ): Promise<void> {
    const components = await tx.comboComponent.findMany({
      where: {
        comboItem: { productId, tenantId },
        componentItem: { productId: { not: productId } },
      },
      select: {
        componentItem: {
          select: {
            id: true,
            sku: true,
            product: { select: { status: true } },
          },
        },
      },
    });
    assertNoDiscontinuedComponent(
      components.map(({ componentItem }) => ({
        ...componentItem,
        productStatus: componentItem.product.status,
      })),
    );
  }

  private async findItem(tenantId: string, itemId: string) {
    const item = await this.prisma.productItem.findFirst({
      where: { id: itemId, tenantId },
      include: ITEM_INCLUDE,
    });
    if (!item)
      throw new NotFoundException({
        code: ErrorCode.PRODUCT_ITEM_NOT_FOUND,
        message: 'Product item not found',
      });

    const stock = await this.stockWithCombos(
      tenantId,
      this.withComponentCombos([item]),
      {},
    );
    return this.toItemResponse(item, stock.get(itemId), stock);
  }

  /** Creates a variant with its images, specs, supplier links and opening stock. Its `itemType` is the product's, never the client's choice. */
  private async insertItem(
    tx: Prisma.TransactionClient,
    tenantId: string,
    productId: string,
    productType: ProductType,
    dto: ItemWithCodes,
  ): Promise<string> {
    const itemType = itemTypeFor(productType);
    if (dto.itemType !== undefined && dto.itemType !== itemType) {
      throw new BadRequestException({
        code: ErrorCode.PRODUCT_ITEM_TYPE_MISMATCH,
        message: `A ${productType} product only holds ${itemType} variants, not ${dto.itemType}`,
      });
    }
    assertComponentsMatchType(itemType, dto.comboComponents);
    // A combo's cost is derived from its components (set by `writeComboComponents` below), so the
    // client's figure, if any, is dropped; everything else must bring one.
    if (itemType !== ProductItemType.COMBO && dto.costPrice === undefined) {
      throw new BadRequestException({
        code: ErrorCode.VALIDATION_FAILED,
        message: 'costPrice is required',
      });
    }
    const item = await tx.productItem.create({
      data: {
        tenantId,
        productId,
        productName: dto.productName,
        productCode: dto.productCode,
        sku: dto.sku,
        barcode: dto.barcode,
        description: dto.description,
        retailPrice: dto.retailPrice,
        costPrice: itemType === ProductItemType.COMBO ? 0 : dto.costPrice!,
        warrantyPeriod: dto.warrantyPeriod,
        vat: dto.vat,
        itemType,
        images: { create: this.imageRows(dto.images) },
        suppliers: {
          create: (dto.supplierIds ?? []).map((supplierId) => ({ supplierId })),
        },
      },
      select: { id: true },
    });
    if (itemType === ProductItemType.COMBO && dto.comboComponents) {
      await writeComboComponents(tx, tenantId, item.id, dto.comboComponents);
    }
    await writeItemDetails(
      tx,
      tenantId,
      productId,
      item.id,
      dto.productDetails ?? [],
    );

    return item.id;
  }

  private imageRows(images: { url: string; isThumbnail?: boolean }[] = []) {
    return images.map((image, position) => ({
      url: image.url,
      isThumbnail: image.isThumbnail ?? false,
      position,
    }));
  }

  private buildProductWhere(
    tenantId: string,
    query: {
      status?: string;
      categoryId?: string;
      supplierId?: string;
      isManufacturable?: boolean;
      productType?: ProductType[];
    } & LocationRefQueryDto,
  ): Prisma.ProductWhereInput {
    const where: Prisma.ProductWhereInput = { tenantId };
    if (query.status) where.status = query.status;
    if (query.productType?.length) {
      where.productType = { in: query.productType };
    }
    if (query.categoryId) where.categoryId = query.categoryId;
    if (query.isManufacturable !== undefined) {
      where.isManufacturable = query.isManufacturable;
    }

    // "Products this supplier supplies" is a fact about the variants, so it is a relation filter rather than the old fetch-ids-then-intersect dance.
    if (query.supplierId) {
      where.productItems = {
        some: { suppliers: { some: { supplierId: query.supplierId } } },
      };
    }

    // **The location deliberately narrows nothing here.** The catalogue belongs to the shop,
    // so every branch and warehouse lists every product; what the location changes is the
    // *number* next to each one (see stockByItem / totalStockByProduct), never whether the
    // row appears. Filtering by `inventories: { some: … }` is the shape to avoid: it makes
    // the existence of a stock row answer "does this shop sell it", and a variant nobody has
    // received yet then reads as "no such product here" instead of "none here yet" - which
    // is exactly what a branch about to order some needs to see.
    return where;
  }

  /**
   * Where each variant's stock sits, one query for the whole page.
   *
   * The query is deliberately **not** narrowed by location: the location splits the rows
   * afterwards instead. Both numbers a location-scoped screen shows - what this branch holds
   * and what the whole chain holds - come out of the same rows, so filtering in SQL would
   * mean a second round trip to recover the total that was just thrown away.
   */
  private async stockByItem(
    tenantId: string,
    itemIds: string[],
    location: LocationRefQueryDto,
  ): Promise<Map<string, ItemStock>> {
    const byItem = new Map<string, ItemStock>();
    if (itemIds.length === 0) return byItem;

    const here = locationMatcher(location);
    const rows = await this.prisma.inventory.findMany({
      where: { tenantId, productItemId: { in: itemIds } },
      select: {
        id: true,
        productItemId: true,
        stock: true,
        lockedStock: true,
        locationId: true,
        location: LOCATION_SELECT,
      },
    });

    for (const row of rows) {
      const entry = byItem.get(row.productItemId) ?? {
        details: [],
        allLocations: 0,
        available: 0,
        availableAllLocations: 0,
      };
      entry.allLocations += row.stock;
      entry.availableAllLocations += shelfOf(row);
      if (here(row)) {
        entry.available += shelfOf(row);
        entry.details.push({
          inventoryId: row.id,
          stock: row.stock,
          location: row.location,
        });
      }
      byItem.set(row.productItemId, entry);
    }
    return byItem;
  }

  /**
   * `stockByItem` for a page that may hold COMBO variants. A combo has no inventory rows, so its
   * figures are derived: the combo is opened down to its leaves (`flattenCombo`) and the scarcest
   * leaf's shelf decides how many whole sets there are, at the viewed location and over the chain.
   * The leaves' stock rides along in the same query as the page's own items.
   */
  private async stockWithCombos(
    tenantId: string,
    items: { id: string; itemType: string }[],
    location: LocationRefQueryDto,
  ): Promise<Map<string, ItemStock>> {
    const comboIds = [
      ...new Set(
        items
          .filter((item) => item.itemType === ProductItemType.COMBO)
          .map((item) => item.id),
      ),
    ];

    const leavesOf = new Map<string, ComboLeaf[]>();
    if (comboIds.length > 0) {
      try {
        const graph = await loadComboGraph(this.prisma, tenantId, comboIds);
        for (const id of comboIds) {
          try {
            leavesOf.set(id, flattenCombo(id, graph));
          } catch {
            // A combo that cannot be opened (empty, cyclic) cannot be sold either: it reads 0 sets below rather than failing the whole search.
          }
        }
      } catch {
        // Same for a graph nested past the limit: every combo on the page reads 0.
      }
    }

    const leafIds = new Set<string>();
    for (const leaves of leavesOf.values()) {
      for (const leaf of leaves) leafIds.add(leaf.item.id);
    }
    const stock = await this.stockByItem(
      tenantId,
      [...new Set([...items.map((item) => item.id), ...leafIds])],
      location,
    );

    for (const id of comboIds) {
      const leaves = leavesOf.get(id);
      stock.set(id, {
        details: [],
        allLocations: 0,
        available: 0,
        availableAllLocations: 0,
        sets: leaves
          ? {
              here: comboSetsAvailable(
                leaves,
                (leafId) => stock.get(leafId)?.available ?? 0,
              ),
              allLocations: comboSetsAvailable(
                leaves,
                (leafId) => stock.get(leafId)?.availableAllLocations ?? 0,
              ),
            }
          : { here: 0, allLocations: 0 },
      });
    }
    return stock;
  }

  /** The same two totals per product, without loading the variants themselves. */
  private async totalStockByProduct(
    tenantId: string,
    productIds: string[],
    location: LocationRefQueryDto,
  ): Promise<Map<string, { here: number; allLocations: number }>> {
    const totals = new Map<string, { here: number; allLocations: number }>();
    if (productIds.length === 0) return totals;

    const here = locationMatcher(location);
    const rows = await this.prisma.inventory.findMany({
      where: { tenantId, productItem: { productId: { in: productIds } } },
      select: {
        stock: true,
        // Only what the matcher reads (id + kind) - nothing about the location is returned here.
        locationId: true,
        location: { select: { type: true } },
        productItem: { select: { productId: true } },
      },
    });

    for (const row of rows) {
      const productId = row.productItem.productId;
      const entry = totals.get(productId) ?? { here: 0, allLocations: 0 };
      entry.allLocations += row.stock;
      if (here(row)) entry.here += row.stock;
      totals.set(productId, entry);
    }
    return totals;
  }

  /** One variant's three stock figures, from the rows (or, for a combo, the sets) behind it. The one copy of this arithmetic: an item and a combo's component are reported the same way. */
  private stockFigures(stock: ItemStock | undefined) {
    const details = stock?.details ?? [];
    return {
      // A combo has no rows: its figures are the sets its components cover (shelf-based, see `comboSetsAvailable`).
      stock:
        stock?.sets?.here ??
        details.reduce((sum, detail) => sum + detail.stock, 0),
      // What the till may actually take: a packed-for-an-order piece is on hand but not for sale, so `stock > 0` alone can promise a sale that `deductStock` then refuses.
      availableStock: stock?.sets?.here ?? stock?.available ?? 0,
      // A variant with no row anywhere is 0 everywhere - the field is always a number, so
      // no caller has to tell "not stocked here" from "not loaded".
      stockAllLocations: stock?.sets?.allLocations ?? stock?.allLocations ?? 0,
    };
  }

  /** The items plus the combos they directly contain, for `stockWithCombos`: a nested combo is shown with its own set count, so it has to be opened too. */
  private withComponentCombos(items: ItemRow[]) {
    return items.flatMap((item) => [
      item,
      ...item.comboComponents.map((part) => part.componentItem),
    ]);
  }

  /** Per combo product, the sets its variants cover here and over the chain. */
  private async comboProductTotals(
    tenantId: string,
    productIds: string[],
    location: LocationRefQueryDto,
  ): Promise<Map<string, { here: number; allLocations: number }>> {
    const totals = new Map<string, { here: number; allLocations: number }>();
    if (productIds.length === 0) return totals;

    const variants = await this.prisma.productItem.findMany({
      where: {
        tenantId,
        productId: { in: productIds },
        itemType: ProductItemType.COMBO,
      },
      select: { id: true, productId: true, itemType: true },
    });
    const stock = await this.stockWithCombos(tenantId, variants, location);
    for (const variant of variants) {
      const sets = stock.get(variant.id)?.sets;
      const entry = totals.get(variant.productId) ?? {
        here: 0,
        allLocations: 0,
      };
      entry.here += sets?.here ?? 0;
      entry.allLocations += sets?.allLocations ?? 0;
      totals.set(variant.productId, entry);
    }
    return totals;
  }

  /** Prices are `Decimal` in Postgres and would serialize as strings, but the old API sent numbers the frontend does arithmetic on - converting here keeps that contract in one place. `all` is the stock of every item the page touched, so each component of a combo can carry its own figures. */
  private toItemResponse(
    item: ItemRow,
    stock: ItemStock | undefined,
    all?: ReadonlyMap<string, ItemStock>,
  ) {
    const { suppliers, comboComponents, retailPrice, costPrice, vat, ...rest } =
      item;
    return {
      ...rest,
      retailPrice: Number(retailPrice),
      costPrice: Number(costPrice),
      vat: vat === null ? null : Number(vat),
      suppliers: suppliers.map((link) => link.supplier),
      comboComponents: comboComponents.map(({ quantity, componentItem }) => {
        const { images, product, ...component } = componentItem;
        return {
          quantity,
          componentItem: {
            ...component,
            retailPrice: Number(component.retailPrice),
            costPrice: Number(component.costPrice),
            thumbnailUrl: thumbnailOf({ images, product }),
            // How many of this component are on hand / for sale, so a combo's expanded row can show why it is or is not in stock. Always numbers; a SERVICE reads 0 (it holds none).
            ...this.stockFigures(all?.get(componentItem.id)),
          },
        };
      }),
      stockDetails: stock?.details ?? [],
      ...this.stockFigures(stock),
    };
  }

  /**
   * Fills in the codes a client left blank. `productCode` becomes the next `SP000001`-style
   * number in the tenant (hand-typed codes of other shapes are left alone and don't move the
   * counter); `sku` defaults to the product code, made unique with a `-2`, `-3` suffix when
   * that string is already a SKU here or earlier in the same request.
   */
  private async allocateItemCodes(
    tenantId: string,
    items: CreateProductItemDto[],
  ): Promise<ItemWithCodes[]> {
    const needsCode = items.some((item) => !item.productCode?.trim());
    let counter = 0;
    if (needsCode) {
      const rows = await this.prisma.productItem.findMany({
        where: { tenantId, productCode: { startsWith: CODE_PREFIX } },
        select: { productCode: true },
      });
      for (const { productCode } of rows) {
        const digits = productCode.slice(CODE_PREFIX.length);
        if (/^\d+$/.test(digits)) counter = Math.max(counter, Number(digits));
      }
    }

    const wantedSkus = items
      .map((item) => item.sku?.trim())
      .filter((sku): sku is string => Boolean(sku));
    const candidates = items
      .map((item) => item.productCode?.trim())
      .filter((code): code is string => Boolean(code));
    const existing = await this.prisma.productItem.findMany({
      where: {
        tenantId,
        OR: [
          { sku: { in: [...wantedSkus, ...candidates] } },
          { sku: { startsWith: CODE_PREFIX } },
        ],
      },
      select: { sku: true },
    });
    const usedSkus = new Set<string>(
      existing.map((row) => row.sku).filter((sku): sku is string => !!sku),
    );
    for (const sku of wantedSkus) usedSkus.add(sku);

    return items.map((item) => {
      const productCode =
        item.productCode?.trim() ||
        `${CODE_PREFIX}${String(++counter).padStart(6, '0')}`;
      let sku = item.sku?.trim();
      if (!sku) {
        sku = productCode;
        for (let n = 2; usedSkus.has(sku); n++) sku = `${productCode}-${n}`;
        usedSkus.add(sku);
      }
      return { ...item, productCode, sku };
    });
  }

  private assertNoDuplicateSkusInPayload(items: { sku: string }[]): void {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const item of items) {
      if (seen.has(item.sku)) duplicates.add(item.sku);
      seen.add(item.sku);
    }
    if (duplicates.size > 0) {
      throw new BadRequestException({
        code: ErrorCode.SKU_DUPLICATE_IN_REQUEST,
        message: `Duplicate SKU within the same request: ${[...duplicates].join(', ')}`,
      });
    }
  }

  /** `@@unique([tenantId, sku])` would catch this anyway, but as a bare constraint error naming a column; a tenant creating twenty variants deserves to be told which SKU. */
  private async assertSkusAreFree(
    tenantId: string,
    skus: string[],
    exceptItemId?: string,
  ): Promise<void> {
    const taken = await this.prisma.productItem.findMany({
      where: {
        tenantId,
        sku: { in: skus },
        ...(exceptItemId ? { id: { not: exceptItemId } } : {}),
      },
      select: { sku: true },
    });
    if (taken.length > 0) {
      throw new ConflictException({
        code: ErrorCode.SKU_TAKEN,
        message: `SKU already exists in this shop: ${taken.map((item) => item.sku).join(', ')}`,
      });
    }
  }

  /** Every supplier a batch of variants names has to be in this tenant. Locations are not named here - a variant is created stocked nowhere, and a stock row appears at a location only when a stock movement puts goods there. */
  private async assertItemReferencesExist(
    tenantId: string,
    items: CreateProductItemDto[],
  ): Promise<void> {
    const supplierIds = [
      ...new Set(items.flatMap((item) => item.supplierIds ?? [])),
    ];
    if (supplierIds.length === 0) return;

    const found = await this.prisma.supplier.count({
      where: { tenantId, id: { in: supplierIds } },
    });
    if (found !== supplierIds.length) {
      throw new NotFoundException({
        code: ErrorCode.SUPPLIER_NOT_FOUND,
        message: 'Supplier not found',
      });
    }
  }

  private async assertBrandExists(
    tenantId: string,
    brandId?: string,
  ): Promise<void> {
    if (!brandId) return;
    const brand = await this.prisma.brand.findFirst({
      where: { id: brandId, tenantId },
      select: { id: true },
    });
    if (!brand)
      throw new NotFoundException({
        code: ErrorCode.BRAND_NOT_FOUND,
        message: 'Brand not found',
      });
  }

  /** `Product.categoryName` is a denormalized copy for list screens, filled from the category the product actually points at; `CategoryService` refreshes it on rename. */
  private async resolveCategoryName(
    tenantId: string,
    categoryId?: string,
  ): Promise<string | null> {
    if (!categoryId) return null;
    const category = await this.prisma.category.findFirst({
      where: { id: categoryId, tenantId },
      select: { name: true },
    });
    if (!category)
      throw new NotFoundException({
        code: ErrorCode.CATEGORY_NOT_FOUND,
        message: 'Category not found',
      });
    return category.name;
  }
}
