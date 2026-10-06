import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { OrderService } from './orders.service';
import { OrderReadService } from './order-read.service';
import { OrderItemCustomizationDto } from './dto/order-item-customization.dto';
import {
  FulfillmentType,
  OrderLineType,
  OrderStatus,
} from '../../common/constants/order-status';
import { ProductionRequestStatus } from '../../common/constants/production-request-status';
import { generateReference } from '../../common/utils/reference-generator';
import { ErrorCode } from '../../common/errors/error-codes';
import type { AuthUser } from '../../common/types/auth-user.type';
import type { Prisma } from '../../../generated/prisma/client';

/** Lines that carry goods of their own. A COMBO line is only a price and a SERVICE has nothing to make. */
const CUSTOMIZABLE_LINE_TYPES: readonly string[] = [
  OrderLineType.PRODUCT,
  OrderLineType.COMBO_COMPONENT,
];

/** Once the workshop has the request, what it was asked to make is fixed (contract §3). */
const LOCKING_PRODUCTION_STATUSES: readonly string[] = [
  ProductionRequestStatus.SENT,
  ProductionRequestStatus.PARTIALLY_RECEIVED,
  ProductionRequestStatus.COMPLETED,
];

/** How the named customization fields read as product details on the custom ProductItem. */
const DETAIL_LABELS = {
  material: 'Chất liệu',
  color: 'Màu sắc',
  fabricCode: 'Mã vải',
} as const;

/** A customization as sent, or as stored (where an absent field is null). */
type CustomizationFields = {
  material?: string | null;
  color?: string | null;
  fabricCode?: string | null;
  specs?: readonly { name: string; value: string; unit?: string | null }[];
};

/** The product details a customization writes: its named fields, then each spec (value and unit together). */
export function customizationDetails(
  dto: CustomizationFields,
): { name: string; value: string }[] {
  const details: { name: string; value: string }[] = [];
  for (const key of Object.keys(
    DETAIL_LABELS,
  ) as (keyof typeof DETAIL_LABELS)[]) {
    const value = dto[key];
    if (value) details.push({ name: DETAIL_LABELS[key], value });
  }
  for (const spec of dto.specs ?? []) {
    details.push({
      name: spec.name,
      value: spec.unit ? `${spec.value} ${spec.unit}` : spec.value,
    });
  }
  return details;
}

/** The detail names a customization writes on its ProductItem - only the fields it actually sets, so a catalogue detail it leaves alone stays. */
function ownedDetailNames(dto: CustomizationFields | null): string[] {
  return dto ? customizationDetails(dto).map((detail) => detail.name) : [];
}

/** A line as far as customizing it needs. */
export interface CustomizableLine {
  id: string;
  productItemId: string;
  lineType: string;
  isCustom: boolean;
}

/**
 * A line made to the customer's measure (A-4, contract §2 `PUT /orders/:id/items/:itemId/customization`).
 * The first time, the line moves to a ProductItem of its own - same product, catalogue price and
 * packages, the agreed dimensions, details and drawings - so the custom piece is stocked, packed,
 * shipped and returned like any SKU, and nothing reserved for the catalogue SKU is touched (nothing
 * is reserved since 2026-10-04 anyway). The `OrderItemCustomization` row stays as the record agreed
 * with the customer; the ProductItem is that record in the catalogue's terms. Lots of a custom item
 * are not tied to the line (`InventoryLot.orderItemId` left empty): the item is the line's alone, so
 * a cancelled or returned piece is ordinary stock at once.
 */
@Injectable()
export class OrderCustomizationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrderService,
    private readonly reads: OrderReadService,
  ) {}

  async customize(
    user: AuthUser,
    tenantId: string,
    orderId: string,
    itemId: string,
    dto: OrderItemCustomizationDto,
  ) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, tenantId },
      select: {
        id: true,
        branchId: true,
        status: true,
        fulfillmentType: true,
        items: {
          where: { id: itemId },
          select: {
            id: true,
            productItemId: true,
            lineType: true,
            isCustom: true,
          },
        },
      },
    });
    if (!order)
      throw new NotFoundException({
        code: ErrorCode.ORDER_NOT_FOUND,
        message: 'Order not found',
      });
    const scope = this.orders.branchScope(user);
    if (scope.branchId !== undefined && order.branchId !== scope.branchId) {
      throw new ForbiddenException({
        code: ErrorCode.ORDER_BRANCH_DENIED,
        message: 'This order does not belong to your branch',
      });
    }
    const [line] = order.items;
    if (!line)
      throw new NotFoundException({
        code: ErrorCode.ORDER_ITEM_NOT_FOUND,
        message: 'Order line not found',
      });
    // Only before packing: a packed line's goods are locked on the shelf, the same rule as A-8's line edits.
    if (
      order.fulfillmentType === FulfillmentType.TAKEAWAY ||
      order.status !== OrderStatus.CONFIRMED
    ) {
      throw new ConflictException({
        code: ErrorCode.ORDER_NOT_EDITABLE,
        message: `A line of an order in ${order.status} cannot be customized`,
      });
    }
    this.assertCustomizable(line.lineType);
    await this.assertNotLocked(line.id);

    await this.prisma.$transaction(async (tx) => {
      // Claimed on CONFIRMED (bumping updatedAt): a pack in between wins whole, and an A-8 edit read before this one is refused.
      const claimed = await tx.order.updateMany({
        where: { id: orderId, tenantId, status: OrderStatus.CONFIRMED },
        data: { updatedAt: new Date() },
      });
      if (claimed.count !== 1) {
        throw new ConflictException({
          code: ErrorCode.ORDER_STATUS_CONFLICT,
          message: 'The order status has just changed, please reload',
        });
      }
      await this.apply(tx, tenantId, line, dto);
    });

    return this.reads.findOne(user, tenantId, orderId);
  }

  /** COMBO and SERVICE lines have no goods of their own to make to measure. */
  assertCustomizable(lineType: string) {
    if (!CUSTOMIZABLE_LINE_TYPES.includes(lineType)) {
      throw new BadRequestException({
        code: ErrorCode.ORDER_ITEM_NOT_CUSTOMIZABLE,
        message: `A ${lineType} line cannot be made to measure`,
      });
    }
  }

  /**
   * Writes a customization inside the caller's transaction - this route's, or the manual create's
   * when a line arrives with its specs. The line's first customization gives it its own ProductItem;
   * a later one rewrites that item's dimensions, details and drawings.
   */
  async apply(
    tx: Prisma.TransactionClient,
    tenantId: string,
    line: CustomizableLine,
    dto: OrderItemCustomizationDto,
  ) {
    const item = await tx.productItem.findFirstOrThrow({
      where: { id: line.productItemId, tenantId },
      include: { packages: true },
    });
    const previous = await tx.orderItemCustomization.findUnique({
      where: { orderItemId: line.id },
      include: { specs: true },
    });
    const dimensions = {
      lengthCm: dto.lengthCm ?? item.lengthCm,
      widthCm: dto.widthCm ?? item.widthCm,
      heightCm: dto.heightCm ?? item.heightCm,
    };
    const details = customizationDetails(dto);
    const urls = dto.attachmentUrls ?? [];

    if (!line.isCustom) {
      const replaced = new Set(ownedDetailNames(dto));
      const kept = await tx.productItemDetail.findMany({
        where: { productItemId: item.id },
        orderBy: { position: 'asc' },
      });
      const images = await tx.productItemImage.findMany({
        where: { productItemId: item.id },
        orderBy: { position: 'asc' },
      });
      const custom = await tx.productItem.create({
        data: {
          tenantId,
          productId: item.productId,
          productName: item.productName,
          productCode: item.productCode,
          // Its own SKU (unique per tenant), readable as the catalogue SKU it was made from.
          sku: generateReference(`${item.sku ?? item.productCode}-C`, 3),
          description: item.description,
          retailPrice: item.retailPrice,
          costPrice: item.costPrice,
          vat: item.vat,
          warrantyPeriod: item.warrantyPeriod,
          itemType: item.itemType,
          allowCustomization: true,
          customLeadTimeDays: item.customLeadTimeDays,
          weightKg: item.weightKg,
          volumeM3: item.volumeM3,
          ...dimensions,
          details: {
            create: [
              ...kept
                .filter((d) => !d.name || !replaced.has(d.name))
                .map(({ name, value }) => ({ name, value })),
              ...details,
            ].map((detail, position) => ({ ...detail, position })),
          },
          images: {
            create: [
              ...images.map(({ url, isThumbnail }) => ({ url, isThumbnail })),
              ...urls.map((url) => ({ url, isThumbnail: false })),
            ].map((image, position) => ({ ...image, position })),
          },
          // Packed the same way as the piece it is a variant of; packing (C-1) reads these.
          packages: {
            create: item.packages.map(
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
        },
        select: { id: true, sku: true },
      });
      await tx.orderItem.update({
        where: { id: line.id },
        data: { productItemId: custom.id, sku: custom.sku, isCustom: true },
      });
      // A request still being drafted for this line now asks for the custom piece; a sent one locked the line already.
      await tx.productionRequestItem.updateMany({
        where: {
          orderItemId: line.id,
          productionRequest: { status: ProductionRequestStatus.DRAFT },
        },
        data: { productItemId: custom.id },
      });
    } else {
      // The line already has its own item: replace what the previous customization wrote on it, keep the rest.
      const stale = new Set([
        ...ownedDetailNames(previous),
        ...ownedDetailNames(dto),
      ]);
      await tx.productItemDetail.deleteMany({
        where: { productItemId: item.id, name: { in: [...stale] } },
      });
      const position = await tx.productItemDetail.count({
        where: { productItemId: item.id },
      });
      if (details.length > 0) {
        await tx.productItemDetail.createMany({
          data: details.map((detail, index) => ({
            ...detail,
            productItemId: item.id,
            position: position + index,
          })),
        });
      }
      await tx.productItemImage.deleteMany({
        where: {
          productItemId: item.id,
          url: { in: previous?.attachmentUrls ?? [] },
        },
      });
      const imageCount = await tx.productItemImage.count({
        where: { productItemId: item.id },
      });
      if (urls.length > 0) {
        await tx.productItemImage.createMany({
          data: urls.map((url, index) => ({
            url,
            productItemId: item.id,
            position: imageCount + index,
          })),
        });
      }
      await tx.productItem.update({
        where: { id: item.id },
        data: dimensions,
      });
    }

    const fields = {
      lengthCm: dto.lengthCm ?? null,
      widthCm: dto.widthCm ?? null,
      heightCm: dto.heightCm ?? null,
      material: dto.material ?? null,
      color: dto.color ?? null,
      fabricCode: dto.fabricCode ?? null,
      note: dto.note ?? null,
      attachmentUrls: urls,
    };
    const specs = (dto.specs ?? []).map((spec, position) => ({
      name: spec.name,
      value: spec.value,
      unit: spec.unit ?? null,
      position,
    }));
    await tx.orderItemCustomization.upsert({
      where: { orderItemId: line.id },
      create: {
        tenantId,
        orderItemId: line.id,
        ...fields,
        specs: { create: specs },
      },
      update: { ...fields, specs: { deleteMany: {}, create: specs } },
    });
  }

  /** What a sent production request asked the workshop for can no longer change. */
  private async assertNotLocked(orderItemId: string) {
    const locked = await this.prisma.productionRequestItem.findFirst({
      where: {
        orderItemId,
        productionRequest: { status: { in: [...LOCKING_PRODUCTION_STATUSES] } },
      },
      select: { productionRequest: { select: { code: true } } },
    });
    if (locked) {
      throw new ConflictException({
        code: ErrorCode.ORDER_ITEM_CUSTOM_LOCKED,
        message: `The line is on production request ${locked.productionRequest.code}, already sent to the workshop`,
      });
    }
  }
}
