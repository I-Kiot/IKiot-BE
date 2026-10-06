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

/** Which rows to load. `locationIds: null` = every location, and only then the lines with no source location chosen yet (they belong to no location a staff account could be posted at). */
interface ListScope {
  locationIds: string[] | null;
  productItemIds?: string[];
  /** Pairs to list even with no demand or request behind them - the catalogue view. */
  catalogue?: { locationId: string; productItemId: string }[];
}

/** A (location, SKU) pair an order edit touched - what B-3 compares before and after. */
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
 * "Danh sách cần sản xuất" (hành trình GĐ1 – Bước 4, contract §3 `GET /production-list`). There
 * is no table: every row is recomputed from the open orders, the stock and the open production
 * requests each time it is read, so it can never disagree with them. The arithmetic is in
 * `production-list.ts`; this service only loads the rows - in two rounds of queries however many
 * rows there are (coding rule 19) - and decorates the result.
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
    // An id that is not this shop's would otherwise just filter everything out, and an empty
    // list reads as "nothing to make" - a stale location in the client looked exactly like that.
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

    const onlyShort = query.onlyShort ?? false;
    const locationIds = query.locationId ? [query.locationId] : readable;
    const entries =
      productItemIds?.length === 0
        ? []
        : await this.compute(tenantId, {
            locationIds,
            productItemIds,
            // Short rows always come from demand, so the catalogue is only needed to show the rest.
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
    // `compareRows` already put short rows and rows with orders first; the rest tie, so they
    // are ordered by name here, where the names are known.
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
      // For the filter's badge: how many rows need ordering, whatever filter is on.
      summary: { shortRows },
    };
  }

  /** Every producible SKU (a PRODUCT not discontinued) at every sellable location in scope - what "order anything" lists. */
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
          product: { status: { not: ProductStatus.DISCONTINUED } },
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
   * B-3: how short each touched pair is right now, keyed by `rowKey` (a pair's custom rows
   * included). An order edit takes one snapshot before its change and hands it to
   * `notifyNewShortages` after the commit. The hook belongs in the order module (track A) -
   * this is the half it calls.
   */
  async shortagesFor(
    tenantId: string,
    pairs: StockPair[],
  ): Promise<Map<string, number>> {
    const entries = await this.entriesFor(tenantId, pairs);
    return new Map(entries.map((row) => [row.key, row.shortQuantity]));
  }

  /** After the commit, re-reads the same pairs and tells each location's managers about every row that just became short (`crossedShortage`). Never throws. */
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
      // A missed warning must never undo or fail the order edit that triggered it.
    }
  }

  /** The rows of exactly these (location, SKU) pairs - standard and custom alike. */
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

  /** `null` = every location (owner/admin). A staff account sees the location it is posted at, and one posted nowhere sees nothing - the cash-drawer rule: no posting must not fall through to "no filter". */
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

  // ─── Loading ───────────────────────────────────────────────────────────────

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
          // A counter sale (TAKEAWAY) is paid and deducted on the spot - it never waits on a workshop.
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

    // Superset (every listed location × every listed SKU); the pure function only reads the pairs it needs.
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

  /** Names for every id in the rows: locations, SKUs, the people in charge, and the custom specs - one query each. */
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
