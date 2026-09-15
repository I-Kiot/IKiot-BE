import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SubscriptionService } from '../subscriptions/subscriptions.service';
import {
  locationMatcher,
  toLocationRef,
} from '../../common/dto/location-ref.dto';
import type { LocationRefQueryDto } from '../../common/dto/location-ref.dto';
import {
  ProductStatus,
  QUOTA_COUNTED_PRODUCT_STATUSES,
} from '../../common/constants/product-status';
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

const ITEM_INCLUDE = {
  images: IMAGES_INCLUDE,
  details: {
    select: { id: true, name: true, value: true, position: true },
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
} as const satisfies Prisma.ProductItemInclude;

type ItemRow = Prisma.ProductItemGetPayload<{ include: typeof ITEM_INCLUDE }>;

/** One location's share of a variant's stock, as the old API shaped it. */
export interface StockDetail {
  inventoryId: string;
  locationId: string;
  locationType: string;
  stock: number;
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

    const productId = await this.prisma.$transaction(async (tx) => {
      const product = await tx.product.create({
        data: {
          tenantId,
          name: dto.name,
          brandId: dto.brandId,
          categoryId: dto.categoryId,
          categoryName,
          status: dto.status ?? ProductStatus.ACTIVE,
          images: { create: this.imageRows(dto.images) },
        },
        select: { id: true },
      });

      for (const item of items) {
        await this.insertItem(tx, tenantId, product.id, item);
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
    const stock = await this.stockByItem(
      tenantId,
      items.map((item) => item.id),
      query,
    );

    const data = rows.map(({ brand, ...product }) => {
      const own = items
        .filter((item) => item.productId === product.id)
        .map((item) => this.toItemResponse(item, stock.get(item.id)));
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

    const items = await this.prisma.productItem.findMany({
      where,
      select: {
        id: true,
        productId: true,
        productName: true,
        productCode: true,
        sku: true,
      },
      orderBy: { productName: 'asc' },
      take: query.limit,
    });

    if (!query.branchIds?.length || items.length === 0) return items;

    const rows = await this.prisma.inventory.groupBy({
      by: ['productItemId'],
      where: {
        tenantId,
        branchId: { in: query.branchIds },
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
    const stock = await this.stockByItem(
      tenantId,
      items.map((item) => item.id),
      location,
    );

    const { brand, ...rest } = product;
    const mapped = items.map((item) =>
      this.toItemResponse(item, stock.get(item.id)),
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
      await tx.product.update({
        where: { id },
        data: {
          name: dto.name,
          brandId: dto.brandId,
          categoryId: dto.categoryId,
          categoryName,
          status: dto.status,
        },
      });

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

    await this.prisma.product.update({
      where: { id },
      data: { status: ProductStatus.DISCONTINUED },
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
      select: { id: true },
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
      this.insertItem(tx, tenantId, productId, item),
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
      select: { id: true },
    });
    if (!existing)
      throw new NotFoundException({
        code: ErrorCode.PRODUCT_ITEM_NOT_FOUND,
        message: 'Product item not found',
      });

    if (dto.sku) await this.assertSkusAreFree(tenantId, [dto.sku], itemId);

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
          costPrice: dto.costPrice,
          warrantyPeriod: dto.warrantyPeriod,
          vat: dto.vat,
        },
      });

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
        await tx.productItemDetail.deleteMany({
          where: { productItemId: itemId },
        });
        await tx.productItemDetail.createMany({
          data: dto.productDetails.map((detail, position) => ({
            productItemId: itemId,
            name: detail.name,
            value: detail.value,
            position,
          })),
        });
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

    const [inventories, movements, orders, promotions] = await Promise.all([
      this.prisma.inventory.count({ where: { productItemId: itemId } }),
      this.prisma.stockMovementRequestItem.count({
        where: { productItemId: itemId },
      }),
      this.prisma.orderItem.count({ where: { productItemId: itemId } }),
      this.prisma.promotionProductItem.count({
        where: { productItemId: itemId },
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

    const stock = await this.stockByItem(tenantId, [itemId], {});
    return this.toItemResponse(item, stock.get(itemId));
  }

  /** Creates a variant with its images, specs, supplier links and opening stock. */
  private async insertItem(
    tx: Prisma.TransactionClient,
    tenantId: string,
    productId: string,
    dto: ItemWithCodes,
  ): Promise<string> {
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
        costPrice: dto.costPrice,
        warrantyPeriod: dto.warrantyPeriod,
        vat: dto.vat,
        images: { create: this.imageRows(dto.images) },
        details: {
          create: (dto.productDetails ?? []).map((detail, position) => ({
            name: detail.name,
            value: detail.value,
            position,
          })),
        },
        suppliers: {
          create: (dto.supplierIds ?? []).map((supplierId) => ({ supplierId })),
        },
      },
      select: { id: true },
    });

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
    } & LocationRefQueryDto,
  ): Prisma.ProductWhereInput {
    const where: Prisma.ProductWhereInput = { tenantId };
    if (query.status) where.status = query.status;
    if (query.categoryId) where.categoryId = query.categoryId;

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
        branchId: true,
        warehouseId: true,
      },
    });

    for (const row of rows) {
      const ref = toLocationRef(row);
      if (!ref) continue; // a row naming neither location is broken data, not a location
      const entry = byItem.get(row.productItemId) ?? {
        details: [],
        allLocations: 0,
      };
      entry.allLocations += row.stock;
      if (here(row)) {
        entry.details.push({ inventoryId: row.id, stock: row.stock, ...ref });
      }
      byItem.set(row.productItemId, entry);
    }
    return byItem;
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
        branchId: true,
        warehouseId: true,
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

  /** Prices are `Decimal` in Postgres and would serialize as strings, but the old API sent numbers the frontend does arithmetic on - converting here keeps that contract in one place. */
  private toItemResponse(item: ItemRow, stock: ItemStock | undefined) {
    const { suppliers, retailPrice, costPrice, vat, ...rest } = item;
    const details = stock?.details ?? [];
    return {
      ...rest,
      retailPrice: Number(retailPrice),
      costPrice: Number(costPrice),
      vat: vat === null ? null : Number(vat),
      suppliers: suppliers.map((link) => link.supplier),
      stockDetails: details,
      stock: details.reduce((sum, detail) => sum + detail.stock, 0),
      // A variant with no row anywhere is 0 everywhere - the field is always a number, so
      // no caller has to tell "not stocked here" from "not loaded".
      stockAllLocations: stock?.allLocations ?? 0,
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
