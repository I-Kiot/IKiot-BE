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
import { withNestedProfile } from '../../common/utils/user-profile';
import { QueryPriceHistoryDto } from './dto/query-price-history.dto';
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
import { recordPriceChange } from './product-price-history';
import { ErrorCode } from '../../common/errors/error-codes';
import { LocationType } from '../../common/constants/location-type';
import {
  replaceAttributes,
  upsertAttributeUnits,
  writeItemDetails,
} from './product-attributes';

/** Tiền tố mã sản phẩm tự cấp (`SP000001`, ...). */
const CODE_PREFIX = 'SP';

/** Lô hỏng còn hàng (2026-11-26): nằm ngoài `stock`, chỉ để báo số hỏng và filter "Có hàng hỏng". */
const damagedLotWhere = {
  isSellable: false,
  remainingQuantity: { gt: 0 },
} as const satisfies Prisma.InventoryLotWhereInput;

/** Cùng phép lọc như `locationWhere`, viết cho bảng lô. */
function lotLocationWhere(
  query: LocationRefQueryDto,
): Prisma.InventoryLotWhereInput {
  return {
    ...(query.locationId ? { locationId: query.locationId } : {}),
    ...(query.locationType ? { location: { type: query.locationType } } : {}),
  };
}

/** DTO phiên bản khi `allocateItemCodes` đã điền đủ hai mã và chuẩn hoá mã vạch (trống = null). */
type ItemWithCodes = Omit<CreateProductItemDto, 'barcode'> & {
  productCode: string;
  sku: string;
  barcode: string | null;
};

/** Barcode trống là null để không trùng unique. */
function normalizeBarcode(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

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

/** Ảnh đại diện của phiên bản, không có thì dùng ảnh hàng hoá. */
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
  // Thành phần combo một tầng, sắp theo SKU.
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

/** Phần tồn của một phiên bản tại một địa điểm. */
export interface StockDetail {
  inventoryId: string;
  stock: number;
  /** Trên kệ (`stock − lockedStock`): phần đánh dấu hỏng được. */
  shelf: number;
  /** Hàng hỏng tại đây (lô `isSellable = false`), ngoài `stock` (2026-11-26). */
  damagedQuantity: number;
  /** Chiếc may riêng còn bán được tại đây, theo dòng đơn - để chọn đúng chiếc khi đánh dấu hỏng. */
  customUnits: { orderItemId: string; orderCode: string; quantity: number }[];
  location: LocationRef;
}

/** Tồn của phiên bản tại nơi đang xem và toàn chuỗi. */
interface ItemStock {
  details: StockDetail[];
  allLocations: number;
  /** Số bán được tại nơi đang xem. */
  available: number;
  /** Như trên, nhưng trên mọi địa điểm. */
  availableAllLocations: number;
  /** Số bộ đủ hàng của combo. */
  sets?: { here: number; allLocations: number };
}

/** Service sản phẩm: sản phẩm là danh mục, phiên bản là thứ bán được. */
@Injectable()
export class ProductService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptions: SubscriptionService,
  ) {}

  async create(
    tenantId: string,
    dto: CreateProductDto,
    actorId: string | null = null,
  ) {
    const [productId] = await this.createMany(tenantId, [dto], actorId);
    return this.findOne(tenantId, productId, {});
  }

  /** Tạo nhiều hàng hoá kèm phiên bản trong một transaction. */
  async createMany(
    tenantId: string,
    dtos: CreateProductDto[],
    actorId: string | null = null,
  ): Promise<string[]> {
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
      dtos.length,
    );

    const allItems = dtos.flatMap((dto) => dto.items);
    const coded = await this.allocateItemCodes(tenantId, allItems);
    this.assertNoDuplicateCodesInPayload(coded);
    await this.assertSkusAreFree(
      tenantId,
      coded.map((item) => item.sku),
    );
    await this.assertProductCodesAreFree(
      tenantId,
      coded.map((item) => item.productCode),
    );
    await this.assertBarcodesAreFree(
      tenantId,
      coded.map((item) => item.barcode),
    );
    const categoryNames = await this.categoryNamesOf(
      tenantId,
      dtos.map((dto) => dto.categoryId),
    );
    await this.assertBrandsExist(
      tenantId,
      dtos.map((dto) => dto.brandId),
    );
    await this.assertItemReferencesExist(tenantId, allItems);

    // Phần của từng hàng hoá trong danh sách đã cấp mã, theo thứ tự.
    let offset = 0;
    const batches = dtos.map((dto) => {
      const items = coded.slice(offset, offset + dto.items.length);
      offset += dto.items.length;
      return { dto, items };
    });

    // Tăng timeout transaction cho lô lớn.
    const timeout = Math.max(5_000, allItems.length * 200);
    return this.prisma.$transaction(
      async (tx) => {
        const ids: string[] = [];
        for (const { dto, items } of batches) {
          const productType = dto.productType ?? ProductType.PRODUCT;
          const product = await tx.product.create({
            data: {
              tenantId,
              name: dto.name,
              brandId: dto.brandId,
              categoryId: dto.categoryId,
              categoryName: dto.categoryId
                ? categoryNames.get(dto.categoryId)
                : null,
              status: dto.status ?? ProductStatus.ACTIVE,
              isManufacturable: dto.isManufacturable ?? false,
              productType,
              images: { create: this.imageRows(dto.images) },
            },
            select: { id: true },
          });

          // Thuộc tính (kèm đơn vị) tạo trước, để giá trị của SKU đầu tiên nối đúng vào chúng.
          if (dto.attributes) {
            await upsertAttributeUnits(
              tx,
              tenantId,
              product.id,
              dto.attributes,
            );
          }
          for (const item of items) {
            await this.insertItem(
              tx,
              tenantId,
              product.id,
              productType,
              item,
              actorId,
            );
          }
          ids.push(product.id);
        }
        return ids;
      },
      { timeout, maxWait: 10_000 },
    );
  }

  async findAll(tenantId: string, query: QueryProductDto) {
    const where = this.buildProductWhere(tenantId, query);
    if (query.search) {
      where.name = { contains: query.search, mode: 'insensitive' };
    }
    if (query.hasDamaged) {
      where.AND = [
        {
          productItems: {
            some: {
              inventoryLots: {
                some: { ...damagedLotWhere, ...lotLocationWhere(query) },
              },
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

    // Danh sách sản phẩm không kèm phiên bản.
    const totals = await this.totalStockByProduct(
      tenantId,
      rows.map((row) => row.id),
      query,
    );
    // Tồn của combo tính theo số bộ.
    const comboSets = await this.comboProductTotals(
      tenantId,
      rows
        .filter((row) => row.productType === ProductType.COMBO)
        .map((row) => row.id),
      query,
    );
    for (const [productId, total] of comboSets) totals.set(productId, total);
    const damaged = await this.damagedByProduct(
      tenantId,
      rows.map((row) => row.id),
      query,
    );

    const data = rows.map(({ brand, ...product }) => {
      const total = totals.get(product.id);
      return {
        ...product,
        brandName: brand?.name ?? null,
        totalStock: total?.here ?? 0,
        totalStockAllLocations: total?.allLocations ?? 0,
        // Hàng hỏng nằm ngoài totalStock (lô `isSellable = false`), báo riêng theo cùng phạm vi địa điểm.
        damagedStock: damaged.get(product.id) ?? 0,
      };
    });

    return paginate(data, total, query.page, query.limit);
  }

  /** Tìm sản phẩm cho POS, kèm phiên bản. */
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
    // Dùng AND để không đè bộ lọc `productItems` theo nhà cung cấp mà buildProductWhere có thể đã đặt.
    if (query.itemIds?.length) {
      where.AND = [{ productItems: { some: { id: { in: query.itemIds } } } }];
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

  /** Danh sách phẳng phiên bản cho bộ chọn SKU. */
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
        // Id chi nhánh là id Location; lọc theo loại để id kho không bị tính là chi nhánh.
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

  /** Chi tiết: sản phẩm, mọi phiên bản, và tồn của từng phiên bản ở đâu. */
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
    // Kiểm tenant trước khi update theo id.
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
      // Bật lại combo phải kiểm lại thành phần sau khoá.
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

      // ProductItem.productName là bản sao của tên sản phẩm, nên đổi tên phải cập nhật theo.
      if (dto.name) {
        await tx.productItem.updateMany({
          where: { productId: id, tenantId },
          data: { productName: dto.name },
        });
      }
    });

    return this.findOne(tenantId, id, {});
  }

  /** Thêm một thuộc tính; trùng tên thì trả thuộc tính có sẵn. */
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

  /** Ngừng bán (xoá mềm), từ chối khi còn tồn, phiếu chưa xong hoặc đơn chưa thanh toán. */
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
            // Quan hệ là `details` trên StockMovementRequest, `items` trên Order.
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

    // Kiểm combo dưới cùng khoá với sửa thành phần.
    await this.prisma.$transaction(async (tx) => {
      await lockComboGraph(tx, tenantId);
      // Chặn ngừng bán khi combo đang bán còn chứa SKU này.
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

  async createItem(
    tenantId: string,
    productId: string,
    dto: CreateProductItemDto,
    actorId: string | null = null,
  ) {
    // Thêm phiên bản cần gói còn hiệu lực.
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
    await this.assertProductCodesAreFree(tenantId, [item.productCode]);
    await this.assertBarcodesAreFree(tenantId, [item.barcode]);
    await this.assertItemReferencesExist(tenantId, [item]);

    const itemId = await this.prisma.$transaction((tx) =>
      this.insertItem(
        tx,
        tenantId,
        productId,
        product.productType as ProductType,
        item,
        actorId,
      ),
    );

    return this.findItem(tenantId, itemId);
  }

  /** Lịch sử giá của một mặt hàng, mới nhất trước. */
  async priceHistory(
    tenantId: string,
    itemId: string,
    query: QueryPriceHistoryDto,
  ) {
    const item = await this.prisma.productItem.findFirst({
      where: { id: itemId, tenantId },
      select: {
        id: true,
        productName: true,
        sku: true,
        retailPrice: true,
        costPrice: true,
      },
    });
    if (!item)
      throw new NotFoundException({
        code: ErrorCode.PRODUCT_ITEM_NOT_FOUND,
        message: 'Product item not found',
      });
    const where: Prisma.ProductItemPriceChangeWhereInput = {
      tenantId,
      productItemId: itemId,
      ...(query.field ? { field: query.field } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.productItemPriceChange.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: skipFor(query.page, query.limit),
        take: query.limit,
        include: {
          changedBy: {
            select: {
              id: true,
              phoneNumber: true,
              profileFirstName: true,
              profileLastName: true,
            },
          },
        },
      }),
      this.prisma.productItemPriceChange.count({ where }),
    ]);
    const data = rows.map(({ changedBy, changedById: _by, ...row }) => ({
      ...row,
      changedBy: changedBy ? withNestedProfile(changedBy) : null,
    }));
    return { ...paginate(data, total, query.page, query.limit), item };
  }

  async updateItem(
    tenantId: string,
    itemId: string,
    dto: UpdateProductItemDto,
    actorId: string | null = null,
  ) {
    const existing = await this.prisma.productItem.findFirst({
      where: { id: itemId, tenantId },
      select: {
        id: true,
        productId: true,
        itemType: true,
        retailPrice: true,
        costPrice: true,
      },
    });
    if (!existing)
      throw new NotFoundException({
        code: ErrorCode.PRODUCT_ITEM_NOT_FOUND,
        message: 'Product item not found',
      });

    // Mã trống thì giữ mã hiện tại.
    const sku = dto.sku?.trim() || undefined;
    const productCode = dto.productCode?.trim() || undefined;
    if (sku) await this.assertSkusAreFree(tenantId, [sku], itemId);
    if (productCode) {
      await this.assertProductCodesAreFree(tenantId, [productCode], itemId);
    }
    // Barcode trống thì xoá (null).
    const barcode =
      dto.barcode === undefined ? undefined : normalizeBarcode(dto.barcode);
    if (barcode) await this.assertBarcodesAreFree(tenantId, [barcode], itemId);
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
          productCode,
          sku,
          barcode,
          description: dto.description,
          retailPrice: dto.retailPrice,
          // Giá vốn combo là tổng của các thành phần, do `writeComboComponents` ghi.
          costPrice:
            existing.itemType === ProductItemType.COMBO
              ? undefined
              : dto.costPrice,
          warrantyPeriod: dto.warrantyPeriod,
          vat: dto.vat,
        },
      });
      // Lịch sử giá: một dòng cho mỗi giá thật sự đổi (so theo đồng), cùng transaction với lần sửa.
      await recordPriceChange(tx, {
        tenantId,
        productItemId: itemId,
        before: existing,
        after: {
          retailPrice: dto.retailPrice,
          costPrice:
            existing.itemType === ProductItemType.COMBO
              ? undefined
              : dto.costPrice,
        },
        actorId,
      });
      // Combo phía trên phiên bản này mang giá vốn suy ra từ nó, nên phải tính lại.
      if (
        existing.itemType !== ProductItemType.COMBO &&
        dto.costPrice !== undefined
      ) {
        await recomputeComboCosts(tx, tenantId, [itemId], actorId);
      }

      // Thay toàn bộ hai danh sách khi có gửi.
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
        await writeComboComponents(
          tx,
          tenantId,
          itemId,
          writeComponents,
          actorId,
        );
      }
    });

    return this.findItem(tenantId, itemId);
  }

  /** Xoá cứng phiên bản khi không còn gì trỏ tới. */
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

    await this.prisma.productItem.delete({ where: { id: itemId } });
    return { id: itemId, deleted: true };
  }

  /** Idempotent như `$addToSet` cũ: gắn cùng NCC hai lần không đổi gì. */
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

  /** Combo của sản phẩm chỉ bán lại khi không thành phần nào đã ngừng. */
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

  /** Tạo phiên bản kèm ảnh, thuộc tính, NCC và tồn đầu. `itemType` lấy từ sản phẩm, client không chọn. */
  private async insertItem(
    tx: Prisma.TransactionClient,
    tenantId: string,
    productId: string,
    productType: ProductType,
    dto: ItemWithCodes,
    actorId: string | null = null,
  ): Promise<string> {
    const itemType = itemTypeFor(productType);
    if (dto.itemType !== undefined && dto.itemType !== itemType) {
      throw new BadRequestException({
        code: ErrorCode.PRODUCT_ITEM_TYPE_MISMATCH,
        message: `A ${productType} product only holds ${itemType} variants, not ${dto.itemType}`,
      });
    }
    assertComponentsMatchType(itemType, dto.comboComponents);
    // Giá vốn combo tự tính, bỏ số client gửi.
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
    await recordPriceChange(tx, {
      tenantId,
      productItemId: item.id,
      before: null,
      after: {
        retailPrice: dto.retailPrice,
        costPrice: itemType === ProductItemType.COMBO ? 0 : dto.costPrice,
      },
      actorId,
    });
    if (itemType === ProductItemType.COMBO && dto.comboComponents) {
      await writeComboComponents(
        tx,
        tenantId,
        item.id,
        dto.comboComponents,
        actorId,
      );
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

    // Lọc sản phẩm theo NCC của phiên bản.
    if (query.supplierId) {
      where.productItems = {
        some: { suppliers: { some: { supplierId: query.supplierId } } },
      };
    }

    // Địa điểm không lọc danh sách, chỉ đổi số tồn.
    return where;
  }

  /** Tồn của mọi phiên bản trong trang bằng một truy vấn. */
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

    // Lô hỏng và lô may riêng còn hàng của các dòng này, một query; chỉ dùng cho `details` (nơi đang xem).
    const lots = await this.prisma.inventoryLot.findMany({
      where: {
        tenantId,
        productItemId: { in: itemIds },
        remainingQuantity: { gt: 0 },
        OR: [{ isSellable: false }, { orderItemId: { not: null } }],
      },
      select: {
        locationId: true,
        productItemId: true,
        isSellable: true,
        orderItemId: true,
        remainingQuantity: true,
        orderItem: { select: { order: { select: { code: true } } } },
      },
    });
    const pairKey = (locationId: string, productItemId: string) =>
      `${locationId}:${productItemId}`;
    const damagedAt = new Map<string, number>();
    const customAt = new Map<
      string,
      Map<string, StockDetail['customUnits'][number]>
    >();
    for (const lot of lots) {
      const k = pairKey(lot.locationId, lot.productItemId);
      if (!lot.isSellable) {
        damagedAt.set(k, (damagedAt.get(k) ?? 0) + lot.remainingQuantity);
      } else if (lot.orderItemId) {
        const units =
          customAt.get(k) ??
          new Map<string, StockDetail['customUnits'][number]>();
        const unit = units.get(lot.orderItemId) ?? {
          orderItemId: lot.orderItemId,
          orderCode: lot.orderItem?.order.code ?? '',
          quantity: 0,
        };
        unit.quantity += lot.remainingQuantity;
        units.set(lot.orderItemId, unit);
        customAt.set(k, units);
      }
    }

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
        const k = pairKey(row.locationId, row.productItemId);
        entry.available += shelfOf(row);
        entry.details.push({
          inventoryId: row.id,
          stock: row.stock,
          shelf: shelfOf(row),
          damagedQuantity: damagedAt.get(k) ?? 0,
          customUnits: [...(customAt.get(k)?.values() ?? [])],
          location: row.location,
        });
      }
      byItem.set(row.productItemId, entry);
    }
    return byItem;
  }

  /** Tồn cho trang có combo: tính số bộ từ các món lá. */
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
            // Combo không bung được thì 0 bộ.
          }
        }
      } catch {
        // Lồng quá giới hạn thì mọi combo là 0.
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
        // Chỉ lấy id và loại địa điểm.
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

  /** Số hàng hỏng của từng sản phẩm tại địa điểm đang chọn (hoặc toàn chuỗi), cộng từ lô hỏng còn hàng. */
  private async damagedByProduct(
    tenantId: string,
    productIds: string[],
    location: LocationRefQueryDto,
  ): Promise<Map<string, number>> {
    const byProduct = new Map<string, number>();
    if (productIds.length === 0) return byProduct;
    const lots = await this.prisma.inventoryLot.findMany({
      where: {
        tenantId,
        ...damagedLotWhere,
        ...lotLocationWhere(location),
        productItem: { productId: { in: productIds } },
      },
      select: {
        remainingQuantity: true,
        productItem: { select: { productId: true } },
      },
    });
    for (const lot of lots) {
      const id = lot.productItem.productId;
      byProduct.set(id, (byProduct.get(id) ?? 0) + lot.remainingQuantity);
    }
    return byProduct;
  }

  /** Ba số tồn của một phiên bản. */
  private stockFigures(stock: ItemStock | undefined) {
    const details = stock?.details ?? [];
    return {
      // Combo lấy số bộ.
      stock:
        stock?.sets?.here ??
        details.reduce((sum, detail) => sum + detail.stock, 0),
      // Số bán được, trừ hàng đã đóng gói.
      availableStock: stock?.sets?.here ?? stock?.available ?? 0,
      // Phiên bản chưa có dòng tồn thì là 0.
      stockAllLocations: stock?.sets?.allLocations ?? stock?.allLocations ?? 0,
    };
  }

  /** Các món cùng combo chứa trực tiếp, để tính tồn combo lồng. */
  private withComponentCombos(items: ItemRow[]) {
    return items.flatMap((item) => [
      item,
      ...item.comboComponents.map((part) => part.componentItem),
    ]);
  }

  /** Số bộ của từng combo tại đây và toàn chuỗi. */
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

  /** Đổi Decimal sang số và gắn tồn cho từng thành phần. */
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
            // Tồn của một thành phần combo.
            ...this.stockFigures(all?.get(componentItem.id)),
          },
        };
      }),
      stockDetails: stock?.details ?? [],
      ...this.stockFigures(stock),
    };
  }

  /** Điền mã sản phẩm và SKU còn trống. */
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

    // Bỏ qua số đã được gõ ở dòng khác trong lô.
    const typedCodes = new Set(candidates);
    const nextCode = (): string => {
      let code: string;
      do code = `${CODE_PREFIX}${String(++counter).padStart(6, '0')}`;
      while (typedCodes.has(code));
      return code;
    };

    return items.map((item) => {
      const productCode = item.productCode?.trim() || nextCode();
      let sku = item.sku?.trim();
      if (!sku) {
        sku = productCode;
        for (let n = 2; usedSkus.has(sku); n++) sku = `${productCode}-${n}`;
        usedSkus.add(sku);
      }
      return {
        ...item,
        productCode,
        sku,
        barcode: normalizeBarcode(item.barcode),
      };
    });
  }

  /** SKU, mã và barcode không được trùng trong một request. */
  private assertNoDuplicateCodesInPayload(
    items: { sku: string; productCode: string; barcode: string | null }[],
  ): void {
    const duplicatesOf = (values: string[]): string[] => {
      const seen = new Set<string>();
      const duplicates = new Set<string>();
      for (const value of values) {
        if (seen.has(value)) duplicates.add(value);
        seen.add(value);
      }
      return [...duplicates];
    };
    const skus = duplicatesOf(items.map((item) => item.sku));
    if (skus.length > 0) {
      throw new BadRequestException({
        code: ErrorCode.SKU_DUPLICATE_IN_REQUEST,
        message: `Duplicate SKU within the same request: ${skus.join(', ')}`,
      });
    }
    const codes = duplicatesOf(items.map((item) => item.productCode));
    if (codes.length > 0) {
      throw new BadRequestException({
        code: ErrorCode.PRODUCT_CODE_DUPLICATE_IN_REQUEST,
        message: `Duplicate product code within the same request: ${codes.join(', ')}`,
      });
    }
    const barcodes = duplicatesOf(
      items
        .map((item) => item.barcode)
        .filter((code): code is string => !!code),
    );
    if (barcodes.length > 0) {
      throw new BadRequestException({
        code: ErrorCode.BARCODE_DUPLICATE_IN_REQUEST,
        message: `Duplicate barcode within the same request: ${barcodes.join(', ')}`,
      });
    }
  }

  /** Barcode không được trùng. */
  private async assertBarcodesAreFree(
    tenantId: string,
    barcodes: (string | null)[],
    exceptItemId?: string,
  ): Promise<void> {
    const wanted = barcodes.filter((code): code is string => !!code);
    if (wanted.length === 0) return;
    const taken = await this.prisma.productItem.findMany({
      where: {
        tenantId,
        barcode: { in: wanted },
        ...(exceptItemId ? { id: { not: exceptItemId } } : {}),
      },
      select: { barcode: true },
    });
    if (taken.length > 0) {
      throw new ConflictException({
        code: ErrorCode.BARCODE_TAKEN,
        message: `Barcode already exists in this shop: ${taken.map((item) => item.barcode).join(', ')}`,
      });
    }
  }

  /** Mã sản phẩm không được trùng. */
  private async assertProductCodesAreFree(
    tenantId: string,
    codes: string[],
    exceptItemId?: string,
  ): Promise<void> {
    const taken = await this.prisma.productItem.findMany({
      where: {
        tenantId,
        productCode: { in: codes },
        ...(exceptItemId ? { id: { not: exceptItemId } } : {}),
      },
      select: { productCode: true },
    });
    if (taken.length > 0) {
      throw new ConflictException({
        code: ErrorCode.PRODUCT_CODE_TAKEN,
        message: `Product code already exists in this shop: ${taken.map((item) => item.productCode).join(', ')}`,
      });
    }
  }

  /** SKU không được trùng, báo rõ SKU nào. */
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

  /** Kiểm mọi NCC thuộc tenant. */
  private async assertItemReferencesExist(
    tenantId: string,
    items: Pick<CreateProductItemDto, 'supplierIds'>[],
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
    await this.assertBrandsExist(tenantId, [brandId]);
  }

  private async assertBrandsExist(
    tenantId: string,
    brandIds: (string | undefined)[],
  ): Promise<void> {
    const ids = [...new Set(brandIds.filter((id): id is string => !!id))];
    if (ids.length === 0) return;
    const found = await this.prisma.brand.count({
      where: { id: { in: ids }, tenantId },
    });
    if (found !== ids.length)
      throw new NotFoundException({
        code: ErrorCode.BRAND_NOT_FOUND,
        message: 'Brand not found',
      });
  }

  /** Điền tên danh mục từ `categoryId`. */
  private async resolveCategoryName(
    tenantId: string,
    categoryId?: string,
  ): Promise<string | null> {
    if (!categoryId) return null;
    const names = await this.categoryNamesOf(tenantId, [categoryId]);
    return names.get(categoryId) ?? null;
  }

  /** Kiểm danh mục thuộc tenant, trả id → tên. */
  private async categoryNamesOf(
    tenantId: string,
    categoryIds: (string | undefined)[],
  ): Promise<Map<string, string>> {
    const ids = [...new Set(categoryIds.filter((id): id is string => !!id))];
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.category.findMany({
      where: { id: { in: ids }, tenantId },
      select: { id: true, name: true },
    });
    if (rows.length !== ids.length)
      throw new NotFoundException({
        code: ErrorCode.CATEGORY_NOT_FOUND,
        message: 'Category not found',
      });
    return new Map(rows.map((row) => [row.id, row.name]));
  }
}
