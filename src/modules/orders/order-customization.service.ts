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
import { OrderShortageAlerts } from './order-shortage-alerts';
import { OrderItemCustomizationDto } from './dto/order-item-customization.dto';
import {
  FulfillmentType,
  OrderLineType,
  OrderStatus,
} from '../../common/constants/order-status';
import { ProductionRequestStatus } from '../../common/constants/production-request-status';
import { generateReference } from '../../common/utils/reference-generator';
import { recordPriceChange } from '../products/product-price-history';
import { ErrorCode } from '../../common/errors/error-codes';
import type { AuthUser } from '../../common/types/auth-user.type';
import type { Prisma } from '../../../generated/prisma/client';
import { OrderEventType } from '../../common/constants/order-event-type';
import { recordOrderEvent, userActor } from './order-events';

/** Dòng có hàng riêng. Dòng COMBO chỉ là giá, SERVICE không có gì để làm. */
const CUSTOMIZABLE_LINE_TYPES: readonly string[] = [
  OrderLineType.PRODUCT,
  OrderLineType.COMBO_COMPONENT,
];

/** Khi xưởng đã nhận yêu cầu, thứ được yêu cầu làm bị khóa (contract §3). */
const LOCKING_PRODUCTION_STATUSES: readonly string[] = [
  ProductionRequestStatus.SENT,
  ProductionRequestStatus.PARTIALLY_RECEIVED,
  ProductionRequestStatus.COMPLETED,
];

const DETAIL_LABELS = {
  material: 'Chất liệu',
  color: 'Màu sắc',
  fabricCode: 'Mã vải',
} as const;

type CustomizationFields = {
  material?: string | null;
  color?: string | null;
  fabricCode?: string | null;
  specs?: readonly {
    name: string;
    value: string;
    unit?: string | null;
    attributeId?: string | null;
  }[];
};

export function customizationDetails(
  dto: CustomizationFields,
): { name: string; value: string; attributeId?: string | null }[] {
  const details: {
    name: string;
    value: string;
    attributeId?: string | null;
  }[] = [];
  for (const key of Object.keys(
    DETAIL_LABELS,
  ) as (keyof typeof DETAIL_LABELS)[]) {
    const value = dto[key];
    if (value) details.push({ name: DETAIL_LABELS[key], value });
  }
  for (const spec of dto.specs ?? []) {
    // Giá trị thuộc tính đứng riêng; đơn vị thuộc về thuộc tính, không gộp vào chuỗi.
    details.push(
      spec.attributeId
        ? { name: spec.name, value: spec.value, attributeId: spec.attributeId }
        : {
            name: spec.name,
            value: spec.unit ? `${spec.value} ${spec.unit}` : spec.value,
          },
    );
  }
  return details;
}

/** Chỉ ghi những trường nó thực sự đặt, để thông số danh mục mà nó không đụng tới được giữ nguyên. */
function ownedDetailNames(dto: CustomizationFields | null): string[] {
  return dto ? customizationDetails(dto).map((detail) => detail.name) : [];
}

export interface CustomizableLine {
  id: string;
  productItemId: string;
  lineType: string;
  isCustom: boolean;
}

/**
 * Dòng may theo số đo (A-4, contract §2 `PUT /orders/:id/items/:itemId/customization`).
 * Lần đầu, dòng chuyển sang một ProductItem riêng (cùng sản phẩm, giá và gói của danh mục; kích thước, chi tiết, bản vẽ đã thỏa thuận)
 * để hàng may đo được nhập kho, đóng gói, giao, trả như một SKU. Không đụng hàng giữ cho SKU danh mục (từ 2026-10-04 đã không giữ hàng nữa).
 * Bản ghi `OrderItemCustomization` là thỏa thuận với khách; ProductItem là bản ghi đó theo cách danh mục hiểu.
 * Lô của hàng may đo không gắn vào dòng (`InventoryLot.orderItemId` để trống) nên hàng bị hủy hoặc trả là tồn kho thường ngay.
 */
@Injectable()
export class OrderCustomizationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrderService,
    private readonly reads: OrderReadService,
    private readonly shortages: OrderShortageAlerts,
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
            sourceLocationId: true,
            sku: true,
            productName: true,
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
    // Chỉ trước khi đóng gói: hàng của dòng đã đóng gói bị khóa trên kệ, cùng quy tắc sửa dòng ở A-8.
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

    // Dòng chuyển sang SKU riêng chưa có tồn, nên dòng của nó trên danh sách sản xuất có thể thành thiếu (B-3).
    const shortage = await this.shortages.snapshot(tenantId, [line]);

    await this.prisma.$transaction(async (tx) => {
      // Chiếm đơn ở CONFIRMED (cập nhật updatedAt): đóng gói xen giữa thì bên đó thắng trọn, và lần sửa A-8 đọc trước đó bị từ chối.
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
      await this.apply(tx, tenantId, line, dto, user.userId);
      await recordOrderEvent(tx, userActor(user), {
        tenantId,
        orderId,
        type: OrderEventType.CUSTOMIZATION_SET,
        metadata: {
          itemId: line.id,
          sku: line.sku ?? undefined,
          productName: line.productName ?? undefined,
          firstTime: !line.isCustom,
        },
      });
    });

    await this.shortages.notify(tenantId, orderId, shortage, user.userId);
    return this.reads.findOne(user, tenantId, orderId);
  }

  /** Dòng COMBO và SERVICE không có hàng riêng để may đo. */
  assertCustomizable(lineType: string) {
    if (!CUSTOMIZABLE_LINE_TYPES.includes(lineType)) {
      throw new BadRequestException({
        code: ErrorCode.ORDER_ITEM_NOT_CUSTOMIZABLE,
        message: `A ${lineType} line cannot be made to measure`,
      });
    }
  }

  /**
   * Ghi customization trong transaction của bên gọi: route này, hoặc lúc tạo đơn tay khi dòng gửi kèm thông số.
   * Lần đầu dòng có ProductItem riêng; các lần sau ghi đè kích thước, chi tiết, bản vẽ của item đó.
   */
  async apply(
    tx: Prisma.TransactionClient,
    tenantId: string,
    line: CustomizableLine,
    dto: OrderItemCustomizationDto,
    actorId: string | null = null,
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
    const changedAttributeIds = (dto.specs ?? [])
      .map((spec) => spec.attributeId)
      .filter((id): id is string => !!id);
    const baseValues = await this.baseAttributeValues(
      tx,
      item,
      line,
      previous,
      changedAttributeIds,
    );

    if (!line.isCustom) {
      const replaced = new Set(ownedDetailNames(dto));
      const replacedAttributes = new Set(changedAttributeIds);
      const kept = await tx.productItemDetail.findMany({
        where: { productItemId: item.id },
        orderBy: { position: 'asc' },
      });
      const images = await tx.productItemImage.findMany({
        where: { productItemId: item.id },
        orderBy: { position: 'asc' },
      });
      // SKU và mã hàng riêng (cả hai duy nhất trong tenant), vẫn đọc ra được SKU danh mục nó được làm từ.
      // Mã hàng từng chép nguyên của gốc; từ 2026-11-06 mã hàng cũng là unique nên lấy bằng SKU.
      const customCode = generateReference(
        `${item.sku ?? item.productCode}-C`,
        3,
      );
      const custom = await tx.productItem.create({
        data: {
          tenantId,
          productId: item.productId,
          productName: item.productName,
          productCode: customCode,
          sku: customCode,
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
                .filter(
                  (d) =>
                    (!d.name || !replaced.has(d.name)) &&
                    !(d.attributeId && replacedAttributes.has(d.attributeId)),
                )
                .map(({ name, value, attributeId }) => ({
                  name,
                  value,
                  attributeId,
                })),
              ...details,
            ].map((detail, position) => ({ ...detail, position })),
          },
          images: {
            create: [
              ...images.map(({ url, isThumbnail }) => ({ url, isThumbnail })),
              ...urls.map((url) => ({ url, isThumbnail: false })),
            ].map((image, position) => ({ ...image, position })),
          },
          // Đóng gói giống hệt sản phẩm gốc; bước đóng gói (C-1) đọc các trường này.
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
      // Hàng may đo là một mặt hàng mới mang giá của hàng gốc: ghi giá lúc tạo, người làm là người sửa đơn.
      await recordPriceChange(tx, {
        tenantId,
        productItemId: custom.id,
        before: null,
        after: { retailPrice: item.retailPrice, costPrice: item.costPrice },
        actorId,
      });
      await tx.orderItem.update({
        where: { id: line.id },
        data: { productItemId: custom.id, sku: custom.sku, isCustom: true },
      });
      // Yêu cầu sản xuất đang soạn của dòng này giờ đổi sang hàng may đo; yêu cầu đã gửi thì dòng đã bị khóa từ trước.
      await tx.productionRequestItem.updateMany({
        where: {
          orderItemId: line.id,
          productionRequest: { status: ProductionRequestStatus.DRAFT },
        },
        data: { productItemId: custom.id },
      });
    } else {
      // Dòng đã có item riêng: thay phần customization trước đã ghi, giữ phần còn lại.
      const stale = new Set([
        ...ownedDetailNames(previous),
        ...ownedDetailNames(dto),
      ]);
      await tx.productItemDetail.deleteMany({
        where: {
          productItemId: item.id,
          OR: [
            { name: { in: [...stale] } },
            { attributeId: { in: changedAttributeIds } },
          ],
        },
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
      attributeId: spec.attributeId ?? null,
      baseValue: spec.attributeId
        ? (baseValues.get(spec.attributeId) ?? null)
        : null,
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

  /**
   * Giá trị gốc của từng thuộc tính khách đổi (2026-10-16), để biết "đổi gì so với bản mẫu". Lần đầu đọc từ SKU mẫu;
   * dòng đã có SKU custom thì giữ giá gốc chụp trước đó (SKU custom đã mang giá khách đổi). Thuộc tính
   * không thuộc sản phẩm của dòng là lỗi.
   */
  private async baseAttributeValues(
    tx: Prisma.TransactionClient,
    item: { id: string; productId: string },
    line: CustomizableLine,
    previous: {
      specs: { attributeId: string | null; baseValue: string | null }[];
    } | null,
    attributeIds: string[],
  ): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (attributeIds.length === 0) return result;
    const known = await tx.productAttribute.count({
      where: { id: { in: attributeIds }, productId: item.productId },
    });
    if (known !== new Set(attributeIds).size) {
      throw new BadRequestException({
        code: ErrorCode.PRODUCT_ATTRIBUTE_NOT_FOUND,
        message: 'A changed attribute is not on this product',
      });
    }
    if (line.isCustom) {
      for (const spec of previous?.specs ?? []) {
        if (spec.attributeId && spec.baseValue != null) {
          result.set(spec.attributeId, spec.baseValue);
        }
      }
    }
    const details = await tx.productItemDetail.findMany({
      where: { productItemId: item.id, attributeId: { in: attributeIds } },
      select: { attributeId: true, value: true },
    });
    for (const detail of details) {
      if (
        detail.attributeId &&
        !result.has(detail.attributeId) &&
        detail.value
      ) {
        result.set(detail.attributeId, detail.value);
      }
    }
    return result;
  }

  /** Khi yêu cầu sản xuất đã gửi, phần xưởng được yêu cầu làm không đổi được nữa. */
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
