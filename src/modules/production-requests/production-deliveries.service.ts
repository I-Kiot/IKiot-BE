import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationService } from '../notifications/notifications.service';
import { ProductionRequestNotificationTemplates } from '../notifications/templates/production-request.templates';
import {
  ProductionDeliveryStatus,
  ProductionRequestStatus,
  RECEIVABLE_PRODUCTION_REQUEST_STATUSES,
  WORKSHOP_VISIBLE_PRODUCTION_REQUEST_STATUSES,
} from '../../common/constants/production-request-status';
import { LOCATION_SELECT } from '../../common/dto/location-ref.dto';
import { ErrorCode } from '../../common/errors/error-codes';
import type { AuthUser } from '../../common/types/auth-user.type';
import { paginate, skipFor } from '../../common/utils/pagination';
import { requireTenantId } from '../../common/utils/tenant-scope';
import { withNestedProfile } from '../../common/utils/user-profile';
import { Prisma } from '../../../generated/prisma/client';
import {
  CancelProductionDeliveryDto,
  CreateProductionDeliveryDto,
  QueryProductionDeliveryDto,
  QueryWorkshopProductionRequestDto,
  ReceiveProductionDto,
} from './dto/production-request.dto';
import { ProductionListService } from './production-list.service';
import {
  DETAIL_INCLUDE,
  ProductionRequestService,
  type RequestRow,
} from './production-requests.service';

const PERSON_SELECT = {
  select: {
    id: true,
    phoneNumber: true,
    email: true,
    profileFirstName: true,
    profileLastName: true,
  },
} as const satisfies Prisma.UserDefaultArgs;

const DELIVERY_INCLUDE = {
  productionRequest: {
    select: {
      id: true,
      code: true,
      status: true,
      expectedReadyDate: true,
      supplierId: true,
      locationId: true,
      supplier: { select: { id: true, supplierName: true } },
      location: LOCATION_SELECT,
    },
  },
  createdBy: PERSON_SELECT,
  receivedBy: PERSON_SELECT,
  cancelledBy: PERSON_SELECT,
  items: {
    orderBy: { id: 'asc' },
    select: {
      id: true,
      productionRequestItemId: true,
      quantity: true,
      receivedQuantity: true,
      defectQuantity: true,
      productionRequestItem: {
        select: {
          quantity: true,
          receivedQuantity: true,
          productItemId: true,
          productItem: { select: { sku: true, productName: true } },
        },
      },
    },
  },
} as const satisfies Prisma.ProductionDeliveryInclude;

type DeliveryRow = Prisma.ProductionDeliveryGetPayload<{
  include: typeof DELIVERY_INCLUDE;
}>;

/** Delivery codes: `PGX000123` ("phiếu giao xưởng"). */
export const PRODUCTION_DELIVERY_CODE_PREFIX = 'PGX';

export function nextProductionDeliveryCode(
  existing: string | null | undefined,
  step = 1,
): string {
  const digits = existing?.startsWith(PRODUCTION_DELIVERY_CODE_PREFIX)
    ? existing.slice(PRODUCTION_DELIVERY_CODE_PREFIX.length)
    : '';
  const current = /^\d+$/.test(digits) ? Number(digits) : 0;
  return `${PRODUCTION_DELIVERY_CODE_PREFIX}${String(current + step).padStart(6, '0')}`;
}

/**
 * Which lines would overshoot what was ordered if this delivery went in: received + still pending
 * on other notes + this one, per line. Pure, so the rule is tested without a database.
 */
export function deliveryOvershoots(
  lines: { id: string; quantity: number; receivedQuantity: number }[],
  pending: Map<string, number>,
  delivering: { productionRequestItemId: string; quantity: number }[],
): { lineId: string; room: number }[] {
  const byId = new Map(lines.map((line) => [line.id, line]));
  const over: { lineId: string; room: number }[] = [];
  for (const entry of delivering) {
    const line = byId.get(entry.productionRequestItemId);
    if (!line) continue;
    const room =
      line.quantity - line.receivedQuantity - (pending.get(line.id) ?? 0);
    if (entry.quantity > room) {
      over.push({ lineId: line.id, room: Math.max(0, room) });
    }
  }
  return over;
}

const CODE_ATTEMPTS = 5;

/**
 * Workshop staff (a STAFF account with `users.workshop_id`) and their delivery notes (2026-10-09).
 *
 * The workshop sees every request sent to it, at every location, and writes a delivery note -
 * possibly short, so finished pieces can leave before the rest. The note raises nothing: the
 * workshop is also the party paid by the accepted quantity, so the receiving location counts the
 * goods and confirms the note, which runs the one receipt path (`ProductionRequestService.receiveGoods`).
 */
@Injectable()
export class ProductionDeliveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly requests: ProductionRequestService,
    private readonly productionList: ProductionListService,
    private readonly notifications: NotificationService,
  ) {}

  // ─── Workshop side ─────────────────────────────────────────────────────────

  async listForWorkshop(
    user: AuthUser,
    query: QueryWorkshopProductionRequestDto,
  ) {
    const tenantId = requireTenantId(user);
    const workshopId = this.requireWorkshop(user);
    const where: Prisma.ProductionRequestWhereInput = {
      tenantId,
      supplierId: workshopId,
      status: query.status ?? {
        in: [...WORKSHOP_VISIBLE_PRODUCTION_REQUEST_STATUSES],
      },
    };
    if (query.locationId) where.locationId = query.locationId;
    if (query.search) {
      where.code = { contains: query.search, mode: 'insensitive' };
    }
    const [rows, total] = await Promise.all([
      this.prisma.productionRequest.findMany({
        where,
        include: DETAIL_INCLUDE,
        // Still owed first, then by the day promised.
        orderBy: [{ expectedReadyDate: 'asc' }, { createdAt: 'desc' }],
        skip: skipFor(query.page, query.limit),
        take: query.limit,
      }),
      this.prisma.productionRequest.count({ where }),
    ]);
    return paginate(
      rows.map((row) => this.requests.toResponse(row)),
      total,
      query.page,
      query.limit,
    );
  }

  async findOneForWorkshop(user: AuthUser, id: string) {
    const request = await this.workshopRequest(user, id);
    return this.requests.toResponse(request);
  }

  async create(
    user: AuthUser,
    requestId: string,
    dto: CreateProductionDeliveryDto,
  ) {
    const tenantId = requireTenantId(user);
    const request = await this.workshopRequest(user, requestId);
    this.assertReceivable(request.status);

    const lineIds = new Set(request.items.map((line) => line.id));
    const seen = new Set<string>();
    for (const entry of dto.items) {
      if (!lineIds.has(entry.productionRequestItemId)) {
        throw new BadRequestException({
          code: ErrorCode.IMPORT_PRODUCTION_ITEM_MISMATCH,
          message: 'A line does not belong to this production request',
        });
      }
      if (seen.has(entry.productionRequestItemId)) {
        throw new BadRequestException({
          code: ErrorCode.PRODUCTION_REQUEST_DUPLICATE_ITEM,
          message: 'The same line is listed twice on one delivery note',
        });
      }
      seen.add(entry.productionRequestItemId);
    }

    let deliveryCode: string | null = null;
    for (
      let attempt = 1;
      attempt <= CODE_ATTEMPTS && !deliveryCode;
      attempt++
    ) {
      try {
        deliveryCode = await this.prisma.$transaction(async (tx) => {
          // Serialises notes and receipts against one request: the room left on a line is read
          // after every earlier note on it has committed.
          await tx.$queryRaw`SELECT id FROM production_requests WHERE id = ${requestId} FOR UPDATE`;
          const fresh = await tx.productionRequest.findUniqueOrThrow({
            where: { id: requestId },
            select: {
              status: true,
              items: {
                select: { id: true, quantity: true, receivedQuantity: true },
              },
            },
          });
          this.assertReceivable(fresh.status);

          const pendingRows = await tx.productionDeliveryItem.groupBy({
            by: ['productionRequestItemId'],
            where: {
              delivery: {
                productionRequestId: requestId,
                status: ProductionDeliveryStatus.PENDING,
              },
            },
            _sum: { quantity: true },
          });
          const pending = new Map(
            pendingRows.map((row) => [
              row.productionRequestItemId,
              row._sum.quantity ?? 0,
            ]),
          );
          const over = deliveryOvershoots(fresh.items, pending, dto.items);
          if (over.length > 0) {
            const names = over.map(({ lineId, room }) => {
              const line = request.items.find((l) => l.id === lineId)!;
              return `${line.productItem.sku ?? line.productItemId} (còn giao được ${room})`;
            });
            throw new BadRequestException({
              code: ErrorCode.PRODUCTION_DELIVERY_QTY_EXCEEDS,
              message: `More would be delivered than ordered: ${names.join(', ')}`,
              errors: over,
            });
          }

          const latest = await tx.productionDelivery.findFirst({
            where: {
              tenantId,
              code: { startsWith: PRODUCTION_DELIVERY_CODE_PREFIX },
            },
            orderBy: { code: 'desc' },
            select: { code: true },
          });
          const code = nextProductionDeliveryCode(latest?.code, attempt);
          await tx.productionDelivery.create({
            data: {
              tenantId,
              code,
              productionRequestId: requestId,
              note: dto.note ?? null,
              createdById: user.userId,
              items: {
                create: dto.items.map((entry) => ({
                  productionRequestItemId: entry.productionRequestItemId,
                  quantity: entry.quantity,
                })),
              },
            },
          });
          return code;
        });
      } catch (error) {
        if (!this.isCodeCollision(error)) throw error;
      }
    }
    if (!deliveryCode) {
      throw new ConflictException({
        code: ErrorCode.PRODUCTION_DELIVERY_CODE_UNAVAILABLE,
        message: 'Could not allocate a delivery code; please retry',
      });
    }

    // After the commit: the location must count the goods before they are stock.
    const managers = await this.notifications.managersOfLocation({
      tenantId,
      locationId: request.locationId,
    });
    await this.notifications.notify({
      tenantId,
      recipientIds: [...managers, request.createdBy?.id].filter(
        (id): id is string => !!id && id !== user.userId,
      ),
      referenceId: requestId,
      ...ProductionRequestNotificationTemplates.deliveryCreated({
        deliveryCode,
        requestCode: request.code,
        workshopName: request.supplier.supplierName,
        locationName: request.location.name,
        totalQuantity: dto.items.reduce((sum, e) => sum + e.quantity, 0),
      }),
    });

    return this.requests.toResponse(
      await this.requests.findRow(tenantId, requestId),
    );
  }

  async cancelByWorkshop(
    user: AuthUser,
    id: string,
    dto: CancelProductionDeliveryDto,
  ) {
    const workshopId = this.requireWorkshop(user);
    const delivery = await this.findDelivery(requireTenantId(user), id);
    if (delivery.productionRequest.supplierId !== workshopId) {
      throw this.notFound();
    }
    return this.cancel(user, delivery, dto, true);
  }

  // ─── Location side ─────────────────────────────────────────────────────────

  /** Delivery notes to the caller's location (every location for the owner) - the "chờ nhận" list. Workshop staff get their own workshop's notes. */
  async list(user: AuthUser, query: QueryProductionDeliveryDto) {
    const tenantId = requireTenantId(user);
    const requestWhere: Prisma.ProductionRequestWhereInput = {};
    if (user.workshopId) {
      requestWhere.supplierId = user.workshopId;
      if (query.locationId) requestWhere.locationId = query.locationId;
    } else {
      const readable = this.productionList.readableLocations(user);
      if (
        query.locationId &&
        readable &&
        !readable.includes(query.locationId)
      ) {
        throw this.locationDenied();
      }
      if (query.locationId) requestWhere.locationId = query.locationId;
      else if (readable) requestWhere.locationId = { in: readable };
    }
    if (query.productionRequestId) requestWhere.id = query.productionRequestId;

    const where: Prisma.ProductionDeliveryWhereInput = {
      tenantId,
      productionRequest: requestWhere,
    };
    if (query.status) where.status = query.status;
    if (query.search) {
      where.OR = [
        { code: { contains: query.search, mode: 'insensitive' } },
        {
          productionRequest: {
            code: { contains: query.search, mode: 'insensitive' },
          },
        },
      ];
    }

    const [rows, total] = await Promise.all([
      this.prisma.productionDelivery.findMany({
        where,
        include: DELIVERY_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip: skipFor(query.page, query.limit),
        take: query.limit,
      }),
      this.prisma.productionDelivery.count({ where }),
    ]);
    return paginate(
      rows.map((row) => this.toResponse(row)),
      total,
      query.page,
      query.limit,
    );
  }

  async findOne(user: AuthUser, id: string) {
    const delivery = await this.findDelivery(requireTenantId(user), id);
    this.assertCanSee(user, delivery);
    return this.toResponse(delivery);
  }

  /** The location counts what arrived and confirms the note - this is where stock and the workshop's debt rise. */
  async receive(user: AuthUser, id: string, dto: ReceiveProductionDto) {
    const tenantId = requireTenantId(user);
    const delivery = await this.findDelivery(tenantId, id);
    const request = await this.requests.findRow(
      tenantId,
      delivery.productionRequestId,
    );
    this.requests.assertCanWrite(user, request);
    if (delivery.status !== ProductionDeliveryStatus.PENDING) {
      throw this.requests.deliveryNotPending();
    }
    return this.requests.receiveGoods(user, request, dto, {
      id: delivery.id,
      code: delivery.code,
      createdById: delivery.createdById,
      delivered: new Map(
        delivery.items.map((line) => [
          line.productionRequestItemId,
          line.quantity,
        ]),
      ),
    });
  }

  /** The location refuses the note (wrong goods, nothing arrived). Nothing was ever stock, so nothing moves back. */
  async cancelByLocation(
    user: AuthUser,
    id: string,
    dto: CancelProductionDeliveryDto,
  ) {
    const tenantId = requireTenantId(user);
    const delivery = await this.findDelivery(tenantId, id);
    const request = await this.requests.findRow(
      tenantId,
      delivery.productionRequestId,
    );
    this.requests.assertCanWrite(user, request);
    return this.cancel(user, delivery, dto, false);
  }

  // ─── Shared ────────────────────────────────────────────────────────────────

  private async cancel(
    user: AuthUser,
    delivery: DeliveryRow,
    dto: CancelProductionDeliveryDto,
    byWorkshop: boolean,
  ) {
    const tenantId = requireTenantId(user);
    const now = new Date();
    const moved = await this.prisma.productionDelivery.updateMany({
      where: { id: delivery.id, status: ProductionDeliveryStatus.PENDING },
      data: {
        status: ProductionDeliveryStatus.CANCELLED,
        cancelledById: user.userId,
        cancelledAt: now,
        cancelReason: dto.reason,
      },
    });
    if (moved.count === 0) throw this.requests.deliveryNotPending();

    const request = delivery.productionRequest;
    const recipients = byWorkshop
      ? await this.notifications.managersOfLocation({
          tenantId,
          locationId: request.locationId,
        })
      : [
          ...(await this.requests.workshopStaffOf(
            tenantId,
            request.supplierId,
          )),
          delivery.createdById,
        ];
    await this.notifications.notify({
      tenantId,
      recipientIds: recipients.filter((rid) => rid !== user.userId),
      referenceId: request.id,
      ...ProductionRequestNotificationTemplates.deliveryCancelled({
        deliveryCode: delivery.code,
        requestCode: request.code,
        byWorkshop,
        reason: dto.reason,
      }),
    });
    return this.toResponse(await this.findDelivery(tenantId, delivery.id));
  }

  /** The workshop link every workshop route needs. */
  private requireWorkshop(user: AuthUser): string {
    if (!user.workshopId) {
      throw new ForbiddenException({
        code: ErrorCode.WORKSHOP_STAFF_NOT_LINKED,
        message: 'This account is not linked to a workshop',
      });
    }
    return user.workshopId;
  }

  /** A request the caller's workshop may see: sent to it, and past DRAFT. Anything else answers 404 - another workshop's requests must look like they do not exist. */
  private async workshopRequest(
    user: AuthUser,
    id: string,
  ): Promise<RequestRow> {
    const workshopId = this.requireWorkshop(user);
    const request = await this.requests.findRow(requireTenantId(user), id);
    if (
      request.supplierId !== workshopId ||
      !WORKSHOP_VISIBLE_PRODUCTION_REQUEST_STATUSES.includes(request.status)
    ) {
      throw new NotFoundException({
        code: ErrorCode.PRODUCTION_REQUEST_NOT_FOUND,
        message: 'Production request not found',
      });
    }
    return request;
  }

  private assertReceivable(status: string): void {
    if (!RECEIVABLE_PRODUCTION_REQUEST_STATUSES.includes(status)) {
      throw new ConflictException({
        code: ErrorCode.PRODUCTION_REQUEST_STATUS_INVALID,
        message:
          status === ProductionRequestStatus.COMPLETED
            ? 'This production request is complete; nothing more is expected'
            : `Goods can only be delivered against a SENT or PARTIALLY_RECEIVED production request, not ${status}`,
      });
    }
  }

  private assertCanSee(user: AuthUser, delivery: DeliveryRow): void {
    if (user.workshopId) {
      if (delivery.productionRequest.supplierId !== user.workshopId) {
        throw this.notFound();
      }
      return;
    }
    const readable = this.productionList.readableLocations(user);
    if (readable && !readable.includes(delivery.productionRequest.locationId)) {
      throw this.locationDenied();
    }
  }

  private async findDelivery(
    tenantId: string,
    id: string,
  ): Promise<DeliveryRow> {
    const delivery = await this.prisma.productionDelivery.findFirst({
      where: { id, tenantId },
      include: DELIVERY_INCLUDE,
    });
    if (!delivery) throw this.notFound();
    return delivery;
  }

  private notFound() {
    return new NotFoundException({
      code: ErrorCode.PRODUCTION_DELIVERY_NOT_FOUND,
      message: 'Delivery note not found',
    });
  }

  private locationDenied() {
    return new ForbiddenException({
      code: ErrorCode.PRODUCTION_REQUEST_LOCATION_DENIED,
      message: 'You can only see delivery notes to your own location',
    });
  }

  private isCodeCollision(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    );
  }

  private toResponse(delivery: DeliveryRow) {
    const {
      tenantId,
      createdById,
      receivedById,
      cancelledById,
      createdBy,
      receivedBy,
      cancelledBy,
      productionRequest,
      items,
      ...rest
    } = delivery;
    const { supplierId, locationId, ...request } = productionRequest;
    return {
      ...rest,
      productionRequest: request,
      createdBy: withNestedProfile(createdBy),
      receivedBy: receivedBy ? withNestedProfile(receivedBy) : null,
      cancelledBy: cancelledBy ? withNestedProfile(cancelledBy) : null,
      items: items.map((line) => ({
        id: line.id,
        productionRequestItemId: line.productionRequestItemId,
        productItemId: line.productionRequestItem.productItemId,
        sku: line.productionRequestItem.productItem.sku,
        productName: line.productionRequestItem.productItem.productName,
        quantity: line.quantity,
        receivedQuantity: line.receivedQuantity,
        defectQuantity: line.defectQuantity,
        orderedQuantity: line.productionRequestItem.quantity,
        totalReceivedQuantity: line.productionRequestItem.receivedQuantity,
      })),
    };
  }
}
