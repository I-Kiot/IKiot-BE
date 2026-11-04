import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationService } from '../notifications/notifications.service';
import { ProductionRequestNotificationTemplates } from '../notifications/templates/production-request.templates';
import {
  FulfillmentType,
  OrderItemStatus,
  STOCKED_LINE_TYPES,
  UNSHIPPED_ORDER_STATUSES,
} from '../../common/constants/order-status';
import { OPEN_PRODUCTION_REQUEST_STATUSES } from '../../common/constants/production-request-status';
import {
  LOCATION_SELECT,
  resolveLocations,
} from '../../common/dto/location-ref.dto';
import type { LocationRef } from '../../common/dto/location-ref.dto';
import { ErrorCode } from '../../common/errors/error-codes';
import type { AuthUser } from '../../common/types/auth-user.type';
import { postingOf } from '../../common/utils/location-access';
import { requireTenantId } from '../../common/utils/tenant-scope';
import { paginate, skipFor } from '../../common/utils/pagination';
import { LocationStatus } from '../../common/constants/location-status';
import {
  ProductItemType,
  ProductStatus,
} from '../../common/constants/product-status';
import { withNestedProfile } from '../../common/utils/user-profile';
import type { Prisma } from '../../../generated/prisma/client';
import { QueryProductionListDto } from './dto/production-request.dto';
import {
  buildProductionList,
  crossedShortage,
  type ProductionListEntry,
} from './production-list';

/** Dòng cần tải. `locationIds: null` = mọi địa điểm, và chỉ khi đó mới lấy dòng chưa chọn kho nguồn (chúng không thuộc địa điểm nào nhân viên có thể được gắn vào). */
interface ListScope {
  locationIds: string[] | null;
  productItemIds?: string[];
  /** Cặp cần liệt kê dù không có nhu cầu hay yêu cầu nào phía sau – chế độ danh mục. */
  catalogue?: { locationId: string; productItemId: string }[];
}

/** Cặp (địa điểm, SKU) mà lần sửa đơn chạm tới; B-3 so sánh trước và sau. */
export interface StockPair {
  locationId: string | null;
  productItemId: string;
}

const pairKey = (locationId: string | null, productItemId: string) =>
  `${locationId ?? '-'}|${productItemId}`;

const PERSON_SELECT = {
  select: {
    id: true,
    phoneNumber: true,
    profileFirstName: true,
    profileLastName: true,
  },
} as const satisfies Prisma.UserDefaultArgs;

const CUSTOMIZATION_SELECT = {
  select: {
    lengthCm: true,
    widthCm: true,
    heightCm: true,
    material: true,
    color: true,
    fabricCode: true,
    note: true,
    attachmentUrls: true,
    specs: {
      select: { name: true, value: true, unit: true, position: true },
      orderBy: { position: 'asc' },
    },
  },
} as const satisfies Prisma.OrderItemCustomizationDefaultArgs;

/**
 * "Danh sách cần sản xuất" (hành trình GĐ1 – Bước 4, contract §3 `GET /production-list`). Không có bảng: mỗi dòng được tính lại
 * từ đơn đang mở, tồn kho và yêu cầu sản xuất đang mở mỗi lần đọc, nên không thể lệch với chúng. Phép tính nằm ở `production-list.ts`;
 * service này chỉ tải dòng (hai vòng query bất kể số dòng, coding rule 19) và trang trí kết quả.
 */
@Injectable()
export class ProductionListService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
  ) {}

  async list(user: AuthUser, query: QueryProductionListDto) {
    const tenantId = requireTenantId(user);
    const readable = this.readableLocations(user);
    if (query.locationId && readable && !readable.includes(query.locationId)) {
      throw new ForbiddenException({
        code: ErrorCode.PRODUCTION_REQUEST_LOCATION_DENIED,
        message: 'You can only see the production list of your own location',
      });
    }
    // Id không thuộc shop này sẽ lọc hết mọi dòng, và danh sách rỗng bị hiểu là "không có gì để làm" – địa điểm cũ ở client từng cho đúng kết quả đó.
    if (query.locationId) {
      await resolveLocations(this.prisma, tenantId, [query.locationId]);
    }

    let productItemIds: string[] | undefined;
    if (query.search) {
      const matches = await this.prisma.productItem.findMany({
        where: {
          tenantId,
          OR: [
            { sku: { contains: query.search, mode: 'insensitive' } },
            { productName: { contains: query.search, mode: 'insensitive' } },
          ],
        },
        select: { id: true },
      });
      productItemIds = matches.map((item) => item.id);
    }
    if (query.productItemId) {
      productItemIds = (productItemIds ?? [query.productItemId]).filter(
        (id) => id === query.productItemId,
      );
    }

    const onlyShort = query.onlyShort ?? false;
    const locationIds = query.locationId ? [query.locationId] : readable;
    const entries =
      productItemIds?.length === 0
        ? []
        : await this.compute(tenantId, {
            locationIds,
            productItemIds,
            // Dòng thiếu luôn đến từ nhu cầu, nên danh mục chỉ cần để hiện phần còn lại.
            catalogue: onlyShort
              ? undefined
              : await this.cataloguePairs(
                  tenantId,
                  locationIds,
                  productItemIds,
                ),
          });

    const shortRows = entries.filter((row) => row.shortQuantity > 0).length;
    const filtered = entries.filter(
      (row) =>
        (!onlyShort || row.shortQuantity > 0) &&
        (!query.hasOpenRequest || row.requests.length > 0),
    );
    // `compareRows` đã đưa dòng thiếu và dòng có đơn lên trước; phần còn lại bằng nhau nên xếp theo tên ở đây, vì tên chỉ biết ở đây.
    const rank = new Map(filtered.map((row, index) => [row.key, index]));
    const rows = (await this.decorate(tenantId, filtered)).sort((a, b) => {
      const ra = rank.get(a.key)!;
      const rb = rank.get(b.key)!;
      const aIdle = a.shortQuantity === 0 && a.orders.length === 0;
      const bIdle = b.shortQuantity === 0 && b.orders.length === 0;
      if (!aIdle || !bIdle) return ra - rb;
      return (
        (a.sku ?? a.productName).localeCompare(b.sku ?? b.productName, 'vi') ||
        (a.location?.name ?? '').localeCompare(b.location?.name ?? '', 'vi')
      );
    });

    const start = skipFor(query.page, query.limit);
    return {
      ...paginate(
        rows.slice(start, start + query.limit),
        rows.length,
        query.page,
        query.limit,
      ),
      // Cho huy hiệu của bộ lọc: số dòng cần đặt, bất kể bộ lọc nào đang bật.
      summary: { shortRows },
    };
  }

  /** Mọi SKU sản xuất được (PRODUCT chưa ngừng, của sản phẩm có `isManufacturable`) ở mọi địa điểm bán được trong phạm vi – thứ "đặt bất kỳ gì" liệt kê. */
  private async cataloguePairs(
    tenantId: string,
    locationIds: string[] | null,
    productItemIds: string[] | undefined,
  ) {
    const [locations, items] = await Promise.all([
      this.prisma.location.findMany({
        where: {
          tenantId,
          isSellable: true,
          status: { not: LocationStatus.DELETED },
          ...(locationIds ? { id: { in: locationIds } } : {}),
        },
        select: { id: true },
      }),
      this.prisma.productItem.findMany({
        where: {
          tenantId,
          itemType: ProductItemType.PRODUCT,
          product: {
            status: { not: ProductStatus.DISCONTINUED },
            isManufacturable: true,
          },
          ...(productItemIds ? { id: { in: productItemIds } } : {}),
        },
        select: { id: true },
      }),
    ]);
    return locations.flatMap((location) =>
      items.map((item) => ({
        locationId: location.id,
        productItemId: item.id,
      })),
    );
  }

  /**
   * B-3: mỗi cặp bị chạm đang thiếu bao nhiêu ngay bây giờ, khoá bởi `rowKey` (gồm cả dòng tuỳ chỉnh của cặp). Lần sửa đơn
   * chụp một snapshot trước khi đổi và đưa cho `notifyNewShortages` sau commit. Hook thuộc module đơn (track A); đây là nửa nó gọi.
   */
  async shortagesFor(
    tenantId: string,
    pairs: StockPair[],
  ): Promise<Map<string, number>> {
    const entries = await this.entriesFor(tenantId, pairs);
    return new Map(entries.map((row) => [row.key, row.shortQuantity]));
  }

  /** Sau commit, đọc lại các cặp đó và báo quản lý từng địa điểm về mỗi dòng vừa thành thiếu (`crossedShortage`). Không bao giờ ném lỗi. */
  async notifyNewShortages(
    tenantId: string,
    pairs: StockPair[],
    before: Map<string, number>,
    actorId: string,
  ): Promise<void> {
    try {
      const crossed = (await this.entriesFor(tenantId, pairs)).filter((row) =>
        crossedShortage(before.get(row.key) ?? 0, row.shortQuantity),
      );
      if (crossed.length === 0) return;

      const rows = await this.decorate(tenantId, crossed);
      const managers = new Map<string | null, string[]>();
      for (const locationId of new Set(
        rows.map((row) => row.location?.id ?? null),
      )) {
        managers.set(
          locationId,
          await this.notifications.managersOfLocation({ tenantId, locationId }),
        );
      }
      for (const row of rows) {
        const recipients = managers.get(row.location?.id ?? null) ?? [];
        await this.notifications.notify({
          tenantId,
          recipientIds: recipients.filter((id) => id !== actorId),
          referenceId: row.productItemId,
          ...ProductionRequestNotificationTemplates.shortageDetected({
            label: row.sku ?? row.productName,
            locationName: row.location?.name ?? null,
            locationId: row.location?.id ?? null,
            productItemId: row.productItemId,
            shortQuantity: row.shortQuantity,
          }),
        });
      }
    } catch {
      // Cảnh báo lỡ không được làm hỏng hay huỷ lần sửa đơn đã kích hoạt nó.
    }
  }

  /** Các dòng đúng những cặp (địa điểm, SKU) này, cả chuẩn lẫn tuỳ chỉnh. */
  private async entriesFor(
    tenantId: string,
    pairs: StockPair[],
  ): Promise<ProductionListEntry[]> {
    if (pairs.length === 0) return [];
    const wanted = new Set(
      pairs.map((pair) => pairKey(pair.locationId, pair.productItemId)),
    );
    const entries = await this.compute(tenantId, {
      locationIds: null,
      productItemIds: [...new Set(pairs.map((pair) => pair.productItemId))],
    });
    return entries.filter((row) =>
      wanted.has(pairKey(row.locationId, row.productItemId)),
    );
  }

  /** `null` = mọi địa điểm (chủ/admin). Nhân viên chỉ thấy địa điểm được gắn; chưa gắn nơi nào thì không thấy gì, không được rơi xuống "không lọc" (quy tắc két tiền). */
  readableLocations(user: AuthUser): string[] | null {
    const own = postingOf(user);
    if (!own) return null;
    if (!own.locationId) {
      throw new ForbiddenException({
        code: ErrorCode.PRODUCTION_REQUEST_LOCATION_DENIED,
        message: 'This account is not posted at any location',
      });
    }
    return [own.locationId];
  }

  private async compute(
    tenantId: string,
    scope: ListScope,
  ): Promise<ProductionListEntry[]> {
    const itemFilter = scope.productItemIds
      ? { productItemId: { in: scope.productItemIds } }
      : {};

    const [demandRows, requestRows] = await Promise.all([
      this.prisma.orderItem.findMany({
        where: {
          ...itemFilter,
          status: OrderItemStatus.PENDING,
          lineType: { in: [...STOCKED_LINE_TYPES] },
          // Bán tại quầy (TAKEAWAY) được trả và trừ kho ngay, không bao giờ chờ xưởng.
          order: {
            tenantId,
            status: { in: [...UNSHIPPED_ORDER_STATUSES] },
            fulfillmentType: { not: FulfillmentType.TAKEAWAY },
          },
          ...(scope.locationIds
            ? { sourceLocationId: { in: scope.locationIds } }
            : {}),
        },
        select: {
          id: true,
          productItemId: true,
          quantity: true,
          isCustom: true,
          sourceLocationId: true,
          order: {
            select: {
              id: true,
              code: true,
              status: true,
              priority: true,
              requestedDeliveryDate: true,
              assigneeId: true,
            },
          },
        },
      }),
      this.prisma.productionRequestItem.findMany({
        where: {
          ...itemFilter,
          productionRequest: {
            tenantId,
            status: { in: [...OPEN_PRODUCTION_REQUEST_STATUSES] },
            ...(scope.locationIds
              ? { locationId: { in: scope.locationIds } }
              : {}),
          },
        },
        select: {
          productItemId: true,
          quantity: true,
          receivedQuantity: true,
          orderItem: { select: { id: true, isCustom: true } },
          productionRequest: {
            select: {
              id: true,
              code: true,
              status: true,
              expectedReadyDate: true,
              locationId: true,
              supplier: { select: { supplierName: true } },
            },
          },
        },
      }),
    ]);

    const locationIds = new Set<string>();
    const productItemIds = new Set<string>();
    for (const line of demandRows) {
      if (line.sourceLocationId) locationIds.add(line.sourceLocationId);
      productItemIds.add(line.productItemId);
    }
    for (const line of requestRows) {
      locationIds.add(line.productionRequest.locationId);
      productItemIds.add(line.productItemId);
    }
    for (const pair of scope.catalogue ?? []) {
      locationIds.add(pair.locationId);
      productItemIds.add(pair.productItemId);
    }
    if (productItemIds.size === 0) return [];

    // Tập trên (mọi địa điểm × mọi SKU đã liệt kê); hàm thuần chỉ đọc các cặp nó cần.
    const pairWhere = {
      tenantId,
      locationId: { in: [...locationIds] },
      productItemId: { in: [...productItemIds] },
    };
    const [stockRows, customLots] =
      locationIds.size === 0
        ? [[], []]
        : await Promise.all([
            this.prisma.inventory.findMany({
              where: pairWhere,
              select: { locationId: true, productItemId: true, stock: true },
            }),
            this.prisma.inventoryLot.findMany({
              where: {
                ...pairWhere,
                orderItemId: { not: null },
                remainingQuantity: { gt: 0 },
              },
              select: {
                locationId: true,
                productItemId: true,
                orderItemId: true,
                remainingQuantity: true,
              },
            }),
          ]);

    return buildProductionList({
      catalogue: scope.catalogue,
      demand: demandRows.map((line) => ({
        orderItemId: line.id,
        orderId: line.order.id,
        orderCode: line.order.code,
        orderStatus: line.order.status,
        priority: line.order.priority,
        requestedDeliveryDate: line.order.requestedDeliveryDate,
        assigneeId: line.order.assigneeId,
        locationId: line.sourceLocationId,
        productItemId: line.productItemId,
        quantity: line.quantity,
        isCustom: line.isCustom,
      })),
      stock: stockRows,
      customLots: customLots.map((lot) => ({
        locationId: lot.locationId,
        productItemId: lot.productItemId,
        orderItemId: lot.orderItemId!,
        remaining: lot.remainingQuantity,
      })),
      requests: requestRows.map((line) => ({
        requestId: line.productionRequest.id,
        code: line.productionRequest.code,
        status: line.productionRequest.status,
        supplierName: line.productionRequest.supplier.supplierName,
        expectedReadyDate: line.productionRequest.expectedReadyDate,
        locationId: line.productionRequest.locationId,
        productItemId: line.productItemId,
        customOrderItemId: line.orderItem?.isCustom ? line.orderItem.id : null,
        quantity: line.quantity,
        receivedQuantity: line.receivedQuantity,
      })),
    });
  }

  /** Tên cho mọi id trong dòng: địa điểm, SKU, người phụ trách, thông số tuỳ chỉnh; mỗi loại một query. */
  private async decorate(tenantId: string, entries: ProductionListEntry[]) {
    if (entries.length === 0) return [];

    const locationIds = new Set<string>();
    const productItemIds = new Set<string>();
    const assigneeIds = new Set<string>();
    const customLineIds = new Set<string>();
    for (const row of entries) {
      if (row.locationId) locationIds.add(row.locationId);
      productItemIds.add(row.productItemId);
      if (row.customOrderItemId) customLineIds.add(row.customOrderItemId);
      for (const order of row.orders) {
        if (order.assigneeId) assigneeIds.add(order.assigneeId);
      }
    }

    const [locations, items, people, customizations] = await Promise.all([
      this.prisma.location.findMany({
        where: { tenantId, id: { in: [...locationIds] } },
        ...LOCATION_SELECT,
      }),
      this.prisma.productItem.findMany({
        where: { tenantId, id: { in: [...productItemIds] } },
        select: {
          id: true,
          sku: true,
          productName: true,
          product: { select: { isManufacturable: true } },
          details: {
            select: { value: true, position: true },
            orderBy: { position: 'asc' },
          },
        },
      }),
      this.prisma.user.findMany({
        where: { id: { in: [...assigneeIds] } },
        ...PERSON_SELECT,
      }),
      this.prisma.orderItemCustomization.findMany({
        where: { tenantId, orderItemId: { in: [...customLineIds] } },
        select: { orderItemId: true, ...CUSTOMIZATION_SELECT.select },
      }),
    ]);

    const locationById = new Map<string, LocationRef>(
      locations.map((location) => [location.id, location]),
    );
    const itemById = new Map(items.map((item) => [item.id, item]));
    const personById = new Map(
      people.map((person) => [person.id, withNestedProfile(person)]),
    );
    const customizationByLine = new Map(
      customizations.map(
        ({ orderItemId, lengthCm, widthCm, heightCm, ...rest }) => [
          orderItemId,
          {
            ...rest,
            lengthCm: lengthCm === null ? null : Number(lengthCm),
            widthCm: widthCm === null ? null : Number(widthCm),
            heightCm: heightCm === null ? null : Number(heightCm),
          },
        ],
      ),
    );

    return entries.map((row) => {
      const item = itemById.get(row.productItemId);
      const variantValues = item?.details
        .map((detail) => detail.value)
        .filter((value): value is string => !!value);
      return {
        key: row.key,
        location: row.locationId
          ? (locationById.get(row.locationId) ?? null)
          : null,
        productItemId: row.productItemId,
        sku: item?.sku ?? null,
        productName: item?.productName ?? '',
        variantLabel: variantValues?.length ? variantValues.join(' / ') : null,
        // false = chỉ nhập từ NCC; dashboard ẩn "Thêm vào yêu cầu" cho row này.
        isManufacturable: item?.product.isManufacturable ?? false,
        isCustom: row.customOrderItemId !== null,
        customOrderItemId: row.customOrderItemId,
        customization: row.customOrderItemId
          ? (customizationByLine.get(row.customOrderItemId) ?? null)
          : null,
        stock: row.stock,
        demandQuantity: row.demandQuantity,
        onOrderQuantity: row.onOrderQuantity,
        draftQuantity: row.draftQuantity,
        shortQuantity: row.shortQuantity,
        orders: row.orders.map((order) => ({
          orderId: order.orderId,
          orderCode: order.orderCode,
          orderItemId: order.orderItemId,
          quantity: order.quantity,
          priority: order.priority,
          requestedDeliveryDate: order.requestedDeliveryDate,
          assignee: order.assigneeId
            ? (personById.get(order.assigneeId) ?? null)
            : null,
          status: order.orderStatus,
        })),
        requests: row.requests.map((request) => ({
          id: request.requestId,
          code: request.code,
          status: request.status,
          supplierName: request.supplierName,
          quantity: request.quantity,
          receivedQuantity: request.receivedQuantity,
          expectedReadyDate: request.expectedReadyDate,
        })),
      };
    });
  }
}
