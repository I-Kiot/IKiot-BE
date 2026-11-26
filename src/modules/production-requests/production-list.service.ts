import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationService } from '../notifications/notifications.service';
import { ProductionRequestNotificationTemplates } from '../notifications/templates/production-request.templates';
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
import { crossedShortage, type ProductionListEntry } from './production-list';
import {
  loadProductionState,
  productionStateForPairs,
  type StockPair,
} from './production-list.loader';

export type { StockPair } from './production-list.loader';

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

/** Danh sách cần sản xuất, tính lại mỗi lần đọc. */
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
    // Lọc bỏ id không thuộc shop.
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
    const state =
      productItemIds?.length === 0
        ? { entries: [] as ProductionListEntry[] }
        : await loadProductionState(this.prisma, tenantId, {
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

    const entries = state.entries;
    const shortRows = entries.filter((row) => row.shortQuantity > 0).length;
    const filtered = entries.filter(
      (row) =>
        (!onlyShort || row.shortQuantity > 0) &&
        (!query.hasOpenRequest ||
          row.requests.length > 0 ||
          row.orders.some((order) => order.coveredQuantity > 0)),
    );
    // Sắp theo tên cho các dòng bằng nhau.
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

  /** Mọi SKU sản xuất được ở các địa điểm trong phạm vi. */
  private async cataloguePairs(
    tenantId: string,
    locationIds: string[] | null,
    productItemIds: string[] | undefined,
  ) {
    const [locations, items] = await Promise.all([
      this.prisma.location.findMany({
        where: {
          tenantId,
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

  /** Chụp số thiếu hiện tại của các cặp bị chạm. */
  async shortagesFor(
    tenantId: string,
    pairs: StockPair[],
  ): Promise<Map<string, number>> {
    const { entries } = await productionStateForPairs(
      this.prisma,
      tenantId,
      pairs,
    );
    return new Map(entries.map((row) => [row.key, row.shortQuantity]));
  }

  /** Báo quản lý địa điểm về dòng vừa thành thiếu, không ném lỗi. */
  async notifyNewShortages(
    tenantId: string,
    pairs: StockPair[],
    before: Map<string, number>,
    actorId: string,
  ): Promise<void> {
    try {
      const crossed = (
        await productionStateForPairs(this.prisma, tenantId, pairs)
      ).entries.filter((row) =>
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

  /** Phạm vi địa điểm, null là mọi địa điểm. */
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
          remainingQuantity: order.remainingQuantity,
          coveredQuantity: order.coveredQuantity,
          coveredBy: order.coveredBy.map((cover) => ({
            id: cover.requestId,
            code: cover.code,
            status: cover.status,
            quantity: cover.quantity,
          })),
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
