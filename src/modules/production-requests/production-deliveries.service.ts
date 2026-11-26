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
import type { NotificationContent } from '../notifications/notification-content.type';
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
  CancelProductionRequestByWorkshopDto,
} from './dto/production-request.dto';
import { ProductionListService } from './production-list.service';
import {
  DETAIL_INCLUDE,
  orderIdsOf,
  ProductionRequestService,
  productionRef,
  type RequestRow,
} from './production-requests.service';
import { OrderEventType } from '../../common/constants/order-event-type';
import { recordOrderEvents, userActor } from '../orders/order-events';

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

/** Các dòng sẽ vượt số đã đặt nếu ghi phiếu giao này. */
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

/** Service phiếu giao của xưởng; phiếu không đụng tồn, nơi nhận xác nhận mới tăng tồn. */
@Injectable()
export class ProductionDeliveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly requests: ProductionRequestService,
    private readonly productionList: ProductionListService,
    private readonly notifications: NotificationService,
  ) {}

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
        // Còn nợ đứng trước, rồi tới ngày hẹn.
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

  /** Xưởng xác nhận đang làm YCSX; từ đây shop không huỷ được. */
  async accept(user: AuthUser, id: string) {
    const tenantId = requireTenantId(user);
    const request = await this.workshopRequest(user, id);
    if (
      request.status !== ProductionRequestStatus.SENT ||
      request.acceptedAt !== null
    ) {
      throw this.notAcceptable();
    }

    const now = new Date();
    const accepted = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.productionRequest.updateMany({
        where: {
          id,
          supplierId: request.supplierId,
          status: ProductionRequestStatus.SENT,
          acceptedAt: null,
        },
        data: { acceptedAt: now, acceptedById: user.userId },
      });
      if (claimed.count === 0) return false;
      await this.recordWorkshopEvent(
        tx,
        user,
        request,
        OrderEventType.PRODUCTION_STARTED,
      );
      return true;
    });
    if (!accepted) throw this.notAcceptable();

    await this.notifyShop(
      user,
      request,
      ProductionRequestNotificationTemplates.workshopAccepted({
        requestCode: request.code,
        workshopName: request.supplier.supplierName,
      }),
    );
    return this.requests.toResponse(await this.requests.findRow(tenantId, id));
  }

  /** Xưởng huỷ YCSX, dùng chung lõi đổi trạng thái với shop. */
  async cancelRequest(
    user: AuthUser,
    id: string,
    dto: CancelProductionRequestByWorkshopDto,
  ) {
    const request = await this.workshopRequest(user, id);
    const cancelled = await this.requests.changeStatus(
      user,
      request,
      { status: ProductionRequestStatus.CANCELLED, note: dto.reason },
      { byWorkshop: true },
    );
    await this.notifyShop(
      user,
      request,
      ProductionRequestNotificationTemplates.workshopCancelled({
        requestCode: request.code,
        workshopName: request.supplier.supplierName,
        reason: dto.reason,
      }),
    );
    return cancelled;
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
    // Phiếu giao đầu tiên cũng tính là đã nhận làm.
    let newlyAccepted = false;
    for (
      let attempt = 1;
      attempt <= CODE_ATTEMPTS && !deliveryCode;
      attempt++
    ) {
      try {
        deliveryCode = await this.prisma.$transaction(async (tx) => {
          // Khoá YCSX để phiếu giao và lần nhận chạy tuần tự.
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

          // Lập phiếu là xưởng đang làm: shop không được huỷ YCSX có hàng đang đi đường.
          const autoAccepted = await tx.productionRequest.updateMany({
            where: { id: requestId, acceptedAt: null },
            data: { acceptedAt: new Date(), acceptedById: user.userId },
          });
          newlyAccepted = autoAccepted.count === 1;
          if (newlyAccepted) {
            await this.recordWorkshopEvent(
              tx,
              user,
              request,
              OrderEventType.PRODUCTION_STARTED,
            );
          }

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

    // Sau commit: địa điểm phải đếm được hàng trước khi nó thành tồn kho.
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
    if (newlyAccepted) {
      await this.notifyShop(
        user,
        request,
        ProductionRequestNotificationTemplates.workshopAccepted({
          requestCode: request.code,
          workshopName: request.supplier.supplierName,
        }),
      );
    }

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

  /** Danh sách phiếu giao chờ nhận theo địa điểm. */
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

  /** Địa điểm đếm hàng đã về và xác nhận phiếu: tồn kho và công nợ xưởng tăng ở đây. */
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

  /** Địa điểm từ chối phiếu (sai hàng, chưa có gì về). Chưa từng thành tồn nên không có gì phải hoàn lại. */
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

  /** Ghi sự kiện "xưởng nhận làm" lên mỗi đơn có dòng trong YCSX, trong cùng transaction. */
  private async recordWorkshopEvent(
    tx: Prisma.TransactionClient,
    user: AuthUser,
    request: RequestRow,
    type: typeof OrderEventType.PRODUCTION_STARTED,
  ): Promise<void> {
    await recordOrderEvents(
      tx,
      userActor(user),
      orderIdsOf(request.items).map((orderId) => ({
        tenantId: request.tenantId,
        orderId,
        type,
        metadata: productionRef(request),
      })),
    );
  }

  /** Báo shop khi xưởng nhận làm hoặc huỷ YCSX. */
  private async notifyShop(
    user: AuthUser,
    request: RequestRow,
    content: NotificationContent,
  ): Promise<void> {
    const owners = await this.notifications.tenantOwners(request.tenantId);
    const recipients = [request.createdBy?.id, ...owners].filter(
      (rid): rid is string => !!rid && rid !== user.userId,
    );
    await this.notifications.notify({
      tenantId: request.tenantId,
      recipientIds: recipients,
      referenceId: request.id,
      ...content,
    });
  }

  private notAcceptable() {
    return new ConflictException({
      code: ErrorCode.PRODUCTION_REQUEST_NOT_ACCEPTABLE,
      message:
        'Only a SENT production request that nobody has accepted yet can be accepted',
    });
  }

  private requireWorkshop(user: AuthUser): string {
    if (!user.workshopId) {
      throw new ForbiddenException({
        code: ErrorCode.WORKSHOP_STAFF_NOT_LINKED,
        message: 'This account is not linked to a workshop',
      });
    }
    return user.workshopId;
  }

  /** YCSX mà xưởng của người gọi được thấy, còn lại trả 404. */
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
