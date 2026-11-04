import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { InventoryService } from '../inventories/inventories.service';
import { NotificationService } from '../notifications/notifications.service';
import { ProductionRequestNotificationTemplates } from '../notifications/templates/production-request.templates';
import { SupplierService } from '../suppliers/suppliers.service';
import {
  MovementStatus,
  MovementType,
} from '../stock-movement-requests/stock-movement.constants';
import {
  ImportSource,
  InventoryRefType,
  InventoryTxType,
  LotSourceType,
} from '../../common/constants/inventory-ledger';
import { LocationStatus } from '../../common/constants/location-status';
import {
  FulfillmentType,
  OrderItemStatus,
  UNSHIPPED_ORDER_STATUSES,
} from '../../common/constants/order-status';
import { holdsStock } from '../../common/constants/product-status';
import {
  ProductionDeliveryStatus,
  ProductionRequestStatus,
  RECEIVABLE_PRODUCTION_REQUEST_STATUSES,
} from '../../common/constants/production-request-status';
import { SystemRole } from '../../common/constants/system-role';
import { UserStatus } from '../../common/constants/user-status';
import {
  LOCATION_SELECT,
  resolveLocations,
} from '../../common/dto/location-ref.dto';
import { ErrorCode } from '../../common/errors/error-codes';
import type { AuthUser } from '../../common/types/auth-user.type';
import { canActAt } from '../../common/utils/location-access';
import { paginate, skipFor } from '../../common/utils/pagination';
import { requireTenantId } from '../../common/utils/tenant-scope';
import { withNestedProfile } from '../../common/utils/user-profile';
import { Prisma } from '../../../generated/prisma/client';
import {
  CreateProductionRequestDto,
  ProductionRequestLineDto,
  QueryProductionRequestDto,
  ReceiveProductionDto,
  UpdateProductionRequestDto,
  UpdateProductionRequestStatusDto,
} from './dto/production-request.dto';
import { ProductionListService } from './production-list.service';
import {
  manualTransitionViolation,
  nextProductionRequestCode,
  PRODUCTION_REQUEST_CODE_PREFIX,
  statusAfterReceipt,
  type RuleViolation,
} from './production-request-rules';
import { ProductVariantService } from '../products/product-variant.service';

const PERSON_SELECT = {
  select: {
    id: true,
    phoneNumber: true,
    email: true,
    profileFirstName: true,
    profileLastName: true,
  },
} as const satisfies Prisma.UserDefaultArgs;

const IMAGE_SELECT = {
  select: { url: true, isThumbnail: true, position: true },
  orderBy: { position: 'asc' },
} as const;

type ImageRow = { url: string; isThumbnail: boolean };

/** Ảnh đại diện của SKU, không có thì lấy của sản phẩm – thứ tự mà các bộ chọn ở màn khác dùng. */
function thumbnailOf(item: ImageRow[], product: ImageRow[]): string | null {
  const pick = (rows: ImageRow[]) =>
    rows.find((r) => r.isThumbnail)?.url ?? rows[0]?.url;
  return pick(item) ?? pick(product) ?? null;
}

export const DETAIL_INCLUDE = {
  supplier: { select: { id: true, supplierName: true, phoneNumber: true } },
  location: LOCATION_SELECT,
  createdBy: PERSON_SELECT,
  statusUpdatedBy: PERSON_SELECT,
  items: {
    orderBy: { id: 'asc' },
    select: {
      id: true,
      productItemId: true,
      quantity: true,
      receivedQuantity: true,
      note: true,
      attachmentUrls: true,
      productItem: {
        select: {
          productId: true,
          sku: true,
          productName: true,
          costPrice: true,
          retailPrice: true,
          images: IMAGE_SELECT,
          product: { select: { images: IMAGE_SELECT } },
          // Thuộc tính của SKU (2026-10-16) - xưởng đọc từ đây là làm bản nào.
          details: {
            select: { attributeId: true, name: true, value: true },
            orderBy: { position: 'asc' },
          },
        },
      },
      orderItem: {
        select: {
          id: true,
          orderId: true,
          isCustom: true,
          order: { select: { code: true } },
          // Thứ khách đặt riêng cho dòng đơn (2026-10-16): xưởng đọc ngay trên YCSX - đổi gì so với mẫu, ảnh, ghi chú.
          customization: {
            select: {
              note: true,
              attachmentUrls: true,
              specs: {
                select: {
                  attributeId: true,
                  name: true,
                  value: true,
                  unit: true,
                  baseValue: true,
                },
                orderBy: { position: 'asc' },
              },
            },
          },
        },
      },
      // Mỗi lần nhận là một phiếu nhập WORKSHOP mà các dòng trỏ ngược về đây.
      importLines: {
        select: {
          request: {
            select: {
              id: true,
              receivedAt: true,
              receivedBy: PERSON_SELECT,
            },
          },
        },
      },
    },
  },
  // Phiếu giao của xưởng (2026-10-09); phiếu PENDING là hàng đã báo nhưng chưa đếm.
  deliveries: {
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      code: true,
      status: true,
      note: true,
      createdAt: true,
      createdBy: PERSON_SELECT,
      receivedAt: true,
      receivedBy: PERSON_SELECT,
      cancelledAt: true,
      cancelReason: true,
      stockMovementId: true,
      items: {
        select: {
          productionRequestItemId: true,
          quantity: true,
          receivedQuantity: true,
          defectQuantity: true,
        },
      },
    },
  },
} as const satisfies Prisma.ProductionRequestInclude;

export type RequestRow = Prisma.ProductionRequestGetPayload<{
  include: typeof DETAIL_INCLUDE;
}>;

/** Phiếu giao xưởng đang được xác nhận qua `receiveGoods`: các dòng và số xưởng báo đã gửi trên từng dòng. */
export interface DeliveryClaim {
  id: string;
  code: string;
  createdById: string;
  delivered: Map<string, number>;
}

interface PreparedLine {
  productItemId: string;
  quantity: number;
  orderItemId: string | null;
  note: string | null;
}

/** Số lần thử lại tạo mã YCSX mới khi có create đồng thời lấy mất mã vừa tính. */
const CODE_ATTEMPTS = 5;

/**
 * Yêu cầu sản xuất (YCSX): danh sách gửi xưởng qua điện thoại, không tự gửi hay tự làm gì. `receive` là chỗ duy nhất hàng xưởng vào kho: tạo phiếu nhập WORKSHOP, mở một lot cho mỗi dòng đạt và một lot DEFECT cho phần còn lại, rồi ghi công nợ xưởng, trong một transaction. Quyền tới địa điểm dùng `canActAt`.
 */
@Injectable()
export class ProductionRequestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly notifications: NotificationService,
    private readonly suppliers: SupplierService,
    private readonly productionList: ProductionListService,
    private readonly variants: ProductVariantService,
  ) {}

  async findAll(user: AuthUser, query: QueryProductionRequestDto) {
    const tenantId = requireTenantId(user);
    const readable = this.productionList.readableLocations(user);
    if (query.locationId && readable && !readable.includes(query.locationId)) {
      throw this.locationDenied();
    }
    // Địa điểm không thuộc shop → 404, không trả trang rỗng im lặng (xem ProductionListService.list).
    if (query.locationId) {
      await resolveLocations(this.prisma, tenantId, [query.locationId]);
    }

    const where: Prisma.ProductionRequestWhereInput = { tenantId };
    if (query.locationId) where.locationId = query.locationId;
    else if (readable) where.locationId = { in: readable };
    if (query.status) where.status = query.status;
    if (query.supplierId) where.supplierId = query.supplierId;
    if (query.productItemId) {
      where.items = { some: { productItemId: query.productItemId } };
    }
    if (query.search) {
      where.code = { contains: query.search, mode: 'insensitive' };
    }

    const [rows, total] = await Promise.all([
      this.prisma.productionRequest.findMany({
        where,
        include: DETAIL_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip: skipFor(query.page, query.limit),
        take: query.limit,
      }),
      this.prisma.productionRequest.count({ where }),
    ]);
    return paginate(
      rows.map((row) => this.toResponse(row)),
      total,
      query.page,
      query.limit,
    );
  }

  async findOne(user: AuthUser, id: string) {
    const request = await this.findRow(requireTenantId(user), id);
    this.assertCanRead(user, request);
    return this.toResponse(request);
  }

  async create(user: AuthUser, dto: CreateProductionRequestDto) {
    const tenantId = requireTenantId(user);
    await this.suppliers.requireForImport(
      tenantId,
      dto.supplierId,
      ImportSource.WORKSHOP,
    );
    await this.requireReceivingLocation(user, tenantId, dto.locationId);
    const lines = await this.applyVariants(
      user,
      tenantId,
      dto.items,
      await this.prepareLines(tenantId, dto.items),
    );

    const data = {
      tenantId,
      supplierId: dto.supplierId,
      locationId: dto.locationId,
      expectedReadyDate: this.dateOrNull(dto.expectedReadyDate),
      note: dto.note ?? null,
      createdById: user.userId,
      items: { create: lines },
    } satisfies Omit<Prisma.ProductionRequestUncheckedCreateInput, 'code'>;

    // Mã là số kế tiếp sau số cao nhất của shop; `@@unique([tenantId, code])` mới là chốt giữ nó duy nhất, nên create đồng thời
    // lấy mất số của mình sẽ được thử lại với số kế tiếp, thay vì trả 409 mà không ai xử lý được.
    const latest = await this.prisma.productionRequest.findFirst({
      where: { tenantId, code: { startsWith: PRODUCTION_REQUEST_CODE_PREFIX } },
      orderBy: { code: 'desc' },
      select: { code: true },
    });
    for (let attempt = 1; attempt <= CODE_ATTEMPTS; attempt++) {
      try {
        const created = await this.prisma.productionRequest.create({
          data: {
            ...data,
            code: nextProductionRequestCode(latest?.code, attempt),
          },
          include: DETAIL_INCLUDE,
        });
        return this.toResponse(created);
      } catch (error) {
        if (!this.isCodeCollision(error)) throw error;
      }
    }
    throw new ConflictException({
      code: ErrorCode.PRODUCTION_REQUEST_CODE_UNAVAILABLE,
      message: 'Could not allocate a production request code; please retry',
    });
  }

  async update(user: AuthUser, id: string, dto: UpdateProductionRequestDto) {
    const tenantId = requireTenantId(user);
    const request = await this.findRow(tenantId, id);
    this.assertCanWrite(user, request);
    this.assertDraft(request);

    if (dto.supplierId && dto.supplierId !== request.supplierId) {
      await this.suppliers.requireForImport(
        tenantId,
        dto.supplierId,
        ImportSource.WORKSHOP,
      );
    }
    if (dto.locationId && dto.locationId !== request.locationId) {
      await this.requireReceivingLocation(user, tenantId, dto.locationId);
    }
    // Sửa nháp là gửi lại toàn bộ dòng, nên SKU đã có trên nháp này được giữ dù sản phẩm vừa bị tắt isManufacturable.
    const skusAlreadyOnRequest = new Set(
      request.items.map((item) => item.productItemId),
    );
    const lines = dto.items
      ? await this.applyVariants(
          user,
          tenantId,
          dto.items,
          await this.prepareLines(tenantId, dto.items, skusAlreadyOnRequest),
        )
      : null;

    const updated = await this.prisma.$transaction(async (tx) => {
      // Kiểm lại trong lúc ghi: yêu cầu vừa được gửi thì không được sửa nữa.
      const guard = await tx.productionRequest.updateMany({
        where: { id, status: ProductionRequestStatus.DRAFT },
        data: {
          supplierId: dto.supplierId,
          locationId: dto.locationId,
          expectedReadyDate:
            dto.expectedReadyDate === undefined
              ? undefined
              : this.dateOrNull(dto.expectedReadyDate),
          note: dto.note,
        },
      });
      if (guard.count === 0) throw this.violation(this.lockedViolation());
      if (lines) {
        await tx.productionRequestItem.deleteMany({
          where: { productionRequestId: id },
        });
        await tx.productionRequestItem.createMany({
          data: lines.map((line) => ({ ...line, productionRequestId: id })),
        });
      }
      return tx.productionRequest.findUniqueOrThrow({
        where: { id },
        include: DETAIL_INCLUDE,
      });
    });
    return this.toResponse(updated);
  }

  /** "Thêm vào yêu cầu" từ danh sách sản xuất. Cùng SKU cùng dòng đơn thì cộng vào dòng sẵn có, không tạo dòng thứ hai. */
  async addItem(user: AuthUser, id: string, dto: ProductionRequestLineDto) {
    const tenantId = requireTenantId(user);
    const request = await this.findRow(tenantId, id);
    this.assertCanWrite(user, request);
    this.assertDraft(request);
    const [line] = await this.applyVariants(
      user,
      tenantId,
      [dto],
      await this.prepareLines(tenantId, [dto]),
    );

    const updated = await this.prisma.$transaction(async (tx) => {
      const guard = await tx.productionRequest.updateMany({
        where: { id, status: ProductionRequestStatus.DRAFT },
        data: { updatedAt: new Date() },
      });
      if (guard.count === 0) throw this.violation(this.lockedViolation());

      const existing = await tx.productionRequestItem.findFirst({
        where: {
          productionRequestId: id,
          productItemId: line.productItemId,
          orderItemId: line.orderItemId,
        },
        select: { id: true },
      });
      if (existing) {
        await tx.productionRequestItem.update({
          where: { id: existing.id },
          data: { quantity: { increment: line.quantity } },
        });
      } else {
        await tx.productionRequestItem.create({
          data: { ...line, productionRequestId: id },
        });
      }
      return tx.productionRequest.findUniqueOrThrow({
        where: { id },
        include: DETAIL_INCLUDE,
      });
    });
    return this.toResponse(updated);
  }

  async updateStatus(
    user: AuthUser,
    id: string,
    dto: UpdateProductionRequestStatusDto,
  ) {
    const tenantId = requireTenantId(user);
    const request = await this.findRow(tenantId, id);
    this.assertCanWrite(user, request);

    // Phiếu giao còn chờ nghĩa là hàng có thể đang đứng ở cửa: huỷ hoặc đóng thiếu lúc này sẽ khiến phiếu không nhận được.
    if (
      (dto.status === ProductionRequestStatus.CANCELLED ||
        dto.status === ProductionRequestStatus.COMPLETED) &&
      request.deliveries.some(
        (d) => d.status === ProductionDeliveryStatus.PENDING,
      )
    ) {
      throw new ConflictException({
        code: ErrorCode.PRODUCTION_DELIVERY_STATUS_INVALID,
        message:
          'A workshop delivery note is still waiting to be received; receive or cancel it first',
      });
    }

    const receivedAny = request.items.some((line) => line.receivedQuantity > 0);
    const violation = manualTransitionViolation(
      request.status,
      dto.status,
      receivedAny,
      dto.note,
    );
    if (violation) throw this.violation(violation);
    if (
      dto.status === ProductionRequestStatus.SENT &&
      request.items.length === 0
    ) {
      throw new BadRequestException({
        code: ErrorCode.PRODUCTION_REQUEST_EMPTY,
        message: 'A production request with no lines cannot be sent',
      });
    }

    // Huỷ hoặc đóng thiếu làm mất phần còn đang chờ, nên các dòng trên danh sách sản xuất có thể thành thiếu lại:
    // chụp snapshot ngay, báo địa điểm sau khi ghi (quy tắc B-3).
    const releases =
      dto.status === ProductionRequestStatus.CANCELLED ||
      dto.status === ProductionRequestStatus.COMPLETED;
    const pairs = request.items.map((line) => ({
      locationId: request.locationId,
      productItemId: line.productItemId,
    }));
    const before = releases
      ? await this.productionList.shortagesFor(tenantId, pairs)
      : null;

    const closingShort = dto.status === ProductionRequestStatus.COMPLETED;
    const reason = dto.note?.trim();
    const now = new Date();
    // Có điều kiện theo trạng thái đã xét, để hai lần bấm (hoặc một lần nhận chen giữa) không cùng qua được.
    const moved = await this.prisma.productionRequest.updateMany({
      where: { id, status: request.status },
      data: {
        status: dto.status,
        sentAt: dto.status === ProductionRequestStatus.SENT ? now : undefined,
        statusUpdatedById: user.userId,
        statusUpdatedAt: now,
        // Lý do đóng thiếu được ghi vào ghi chú có nhãn, vì đó là dấu vết duy nhất về lý do hàng đã đặt không về.
        note: reason
          ? [request.note, closingShort ? `Đóng thiếu: ${reason}` : reason]
              .filter(Boolean)
              .join('\n')
          : undefined,
      },
    });
    if (moved.count === 0) {
      throw new ConflictException({
        code: ErrorCode.PRODUCTION_REQUEST_STATUS_INVALID,
        message: 'The production request changed meanwhile; reload and retry',
      });
    }
    if (before) {
      await this.productionList.notifyNewShortages(
        tenantId,
        pairs,
        before,
        user.userId,
      );
    }
    return this.toResponse(await this.findRow(tenantId, id));
  }

  /** Chỉ DRAFT – đã gửi thì xưởng đã được báo, nên giữ dấu vết (huỷ thay vì xoá). */
  async remove(user: AuthUser, id: string) {
    const tenantId = requireTenantId(user);
    const request = await this.findRow(tenantId, id);
    this.assertCanWrite(user, request);
    this.assertDraft(request);
    const deleted = await this.prisma.productionRequest.deleteMany({
      where: { id, status: ProductionRequestStatus.DRAFT },
    });
    if (deleted.count === 0) throw this.violation(this.lockedViolation());
    return { success: true };
  }

  /** Địa điểm nhận hàng thẳng từ yêu cầu – đường cho xưởng không có tài khoản. */
  async receive(user: AuthUser, id: string, dto: ReceiveProductionDto) {
    const request = await this.findRow(requireTenantId(user), id);
    this.assertCanWrite(user, request);
    return this.receiveGoods(user, request, dto, null);
  }

  /**
   * Điểm duy nhất hàng xưởng vào kho. Có `delivery` thì lần nhận xác nhận phiếu giao đó: mọi dòng phải có trên phiếu,
   * không quá số xưởng báo đã gửi, và phiếu được khoá trong cùng transaction để hai người cùng xác nhận không thể cùng nhận.
   * Quyền tới địa điểm là việc của người gọi.
   */
  async receiveGoods(
    user: AuthUser,
    request: RequestRow,
    dto: ReceiveProductionDto,
    delivery: DeliveryClaim | null,
  ) {
    const tenantId = requireTenantId(user);
    const id = request.id;
    if (!RECEIVABLE_PRODUCTION_REQUEST_STATUSES.includes(request.status)) {
      throw new ConflictException({
        code: ErrorCode.PRODUCTION_REQUEST_STATUS_INVALID,
        message: `Goods can only be received against a SENT or PARTIALLY_RECEIVED production request, not ${request.status}`,
      });
    }

    const lineById = new Map(request.items.map((line) => [line.id, line]));
    const seen = new Set<string>();
    for (const entry of dto.items) {
      const line = lineById.get(entry.productionRequestItemId);
      if (!line) {
        throw new BadRequestException({
          code: ErrorCode.IMPORT_PRODUCTION_ITEM_MISMATCH,
          message: 'A line does not belong to this production request',
        });
      }
      if (seen.has(line.id)) {
        throw new BadRequestException({
          code: ErrorCode.PRODUCTION_REQUEST_DUPLICATE_ITEM,
          message: `The line for ${line.productItem.sku ?? line.productItemId} is listed twice`,
        });
      }
      seen.add(line.id);
      if ((entry.defectQuantity ?? 0) > entry.receivedQuantity) {
        throw new BadRequestException({
          code: ErrorCode.STOCK_MOVEMENT_DEFECT_QTY_EXCEEDS,
          message: `The defective quantity cannot exceed the received quantity for ${line.productItem.sku ?? line.productItemId}`,
        });
      }
      if (delivery) {
        const sent = delivery.delivered.get(line.id);
        if (sent === undefined) {
          throw new BadRequestException({
            code: ErrorCode.PRODUCTION_DELIVERY_ITEM_MISMATCH,
            message: `${line.productItem.sku ?? line.productItemId} is not on delivery note ${delivery.code}`,
          });
        }
        if (entry.receivedQuantity > sent) {
          throw new BadRequestException({
            code: ErrorCode.PRODUCTION_DELIVERY_RECEIVE_EXCEEDS,
            message: `${entry.receivedQuantity} counted for ${line.productItem.sku ?? line.productItemId}, but the workshop delivered ${sent}`,
          });
        }
      }
      // Chỉ kiểm sơ bộ; việc thực thi là phép tăng có điều kiện trong transaction.
      if (line.receivedQuantity + entry.receivedQuantity > line.quantity) {
        throw this.qtyExceeds(line);
      }
    }
    const arriving = dto.items.filter((entry) => entry.receivedQuantity > 0);
    if (arriving.length === 0) {
      throw new BadRequestException({
        code: ErrorCode.PRODUCTION_REQUEST_RECEIVE_EMPTY,
        message: 'At least one line must receive more than 0',
      });
    }

    const defectTotal = arriving.reduce(
      (sum, entry) => sum + (entry.defectQuantity ?? 0),
      0,
    );
    const defectLocationId =
      defectTotal > 0
        ? await this.resolveDefectLocation(
            tenantId,
            request,
            dto.defectLocationId,
          )
        : null;

    const priced = arriving.map((entry) => {
      const line = lineById.get(entry.productionRequestItemId)!;
      const defect = entry.defectQuantity ?? 0;
      return {
        entry,
        line,
        defect,
        good: entry.receivedQuantity - defect,
        unitCost: entry.unitCost ?? Number(line.productItem.costPrice),
      };
    });
    // Xưởng được trả tiền cho các cái đạt, theo giá của xưởng – giống nhập NCC.
    const amount = priced.reduce((sum, p) => sum + p.good * p.unitCost, 0);
    const supplier = await this.suppliers.requireForImport(
      tenantId,
      request.supplierId,
      ImportSource.WORKSHOP,
    );
    this.suppliers.assertCreditHeadroom(supplier, amount);

    const now = new Date();
    const { movementId, creditWarning } = await this.prisma.$transaction(
      async (tx) => {
        if (delivery) {
          // Khoá dòng phiếu tới commit; người xác nhận thứ hai chờ ở đây, rồi thấy phiếu không còn PENDING.
          const claimed = await tx.productionDelivery.updateMany({
            where: {
              id: delivery.id,
              status: ProductionDeliveryStatus.PENDING,
            },
            data: { receivedById: user.userId },
          });
          if (claimed.count === 0) throw this.deliveryNotPending();
        }
        for (const p of priced) {
          // Trần nằm trong WHERE, nên hai người cùng nhận một dòng không thể vượt.
          const bumped = await tx.productionRequestItem.updateMany({
            where: {
              id: p.line.id,
              receivedQuantity: {
                lte: p.line.quantity - p.entry.receivedQuantity,
              },
            },
            data: { receivedQuantity: { increment: p.entry.receivedQuantity } },
          });
          if (bumped.count === 0) throw this.qtyExceeds(p.line);
        }

        const movement = await tx.stockMovementRequest.create({
          data: {
            tenantId,
            movementType: MovementType.IMPORT,
            importSource: ImportSource.WORKSHOP,
            status: MovementStatus.RECEIVED,
            fromSupplierId: request.supplierId,
            toLocationId: request.locationId,
            createdById: user.userId,
            receivedById: user.userId,
            receivedAt: now,
            totalPrice: amount,
            note:
              dto.note ??
              (delivery
                ? `Nhận phiếu giao ${delivery.code} theo ${request.code}`
                : `Nhận hàng xưởng theo ${request.code}`),
            details: {
              create: priced.map((p) => ({
                productItemId: p.line.productItemId,
                quantity: p.entry.receivedQuantity,
                importPrice: p.unitCost,
                receivedQuantity: p.entry.receivedQuantity,
                defectQuantity: p.defect,
                defectLocationId: p.defect > 0 ? defectLocationId : null,
                productionRequestItemId: p.line.id,
                note: p.line.note,
              })),
            },
          },
          select: {
            id: true,
            details: { select: { id: true, productionRequestItemId: true } },
          },
        });
        const importLineOf = new Map(
          movement.details.map((d) => [d.productionRequestItemId, d.id]),
        );

        for (const p of priced) {
          const lot = {
            tenantId,
            productItemId: p.line.productItemId,
            unitCost: p.unitCost,
            sourceType: LotSourceType.WORKSHOP,
            supplierId: request.supplierId,
            importItemId: importLineOf.get(p.line.id) ?? null,
            productionRequestItemId: p.line.id,
            receivedAt: now,
          };
          const ledger = {
            referenceType: InventoryRefType.STOCK_MOVEMENT,
            referenceId: movement.id,
            createdById: user.userId,
          };
          if (p.good > 0) {
            // Tồn chỉ tăng ở đây (hành trình Bước 4). Hàng tuỳ chỉnh gắn với dòng đơn của nó, nên đơn khác không lấy được.
            await this.inventory.openLot(tx, {
              ...lot,
              locationId: request.locationId,
              quantity: p.good,
              orderItemId: p.line.orderItem?.isCustom
                ? p.line.orderItem.id
                : null,
              ledger: { ...ledger, type: InventoryTxType.IMPORT },
            });
          }
          if (p.defect > 0) {
            await this.inventory.openLot(tx, {
              ...lot,
              locationId: defectLocationId!,
              quantity: p.defect,
              ledger: { ...ledger, type: InventoryTxType.DEFECT },
            });
          }
        }

        if (delivery) {
          const counted = new Map(
            dto.items.map((e) => [e.productionRequestItemId, e]),
          );
          for (const lineId of delivery.delivered.keys()) {
            const entry = counted.get(lineId);
            await tx.productionDeliveryItem.updateMany({
              where: {
                deliveryId: delivery.id,
                productionRequestItemId: lineId,
              },
              data: {
                receivedQuantity: entry?.receivedQuantity ?? 0,
                defectQuantity: entry?.defectQuantity ?? 0,
              },
            });
          }
          await tx.productionDelivery.update({
            where: { id: delivery.id },
            data: {
              status: ProductionDeliveryStatus.RECEIVED,
              receivedAt: now,
              stockMovementId: movement.id,
            },
          });
        }

        const lines = await tx.productionRequestItem.findMany({
          where: { productionRequestId: id },
          select: { quantity: true, receivedQuantity: true },
        });
        await tx.productionRequest.update({
          where: { id },
          data: {
            status: statusAfterReceipt(lines),
            statusUpdatedById: user.userId,
            statusUpdatedAt: now,
          },
        });

        const warning = await this.suppliers.charge(
          tx,
          tenantId,
          request.supplierId,
          amount,
          priced.filter((p) => p.good > 0).map((p) => p.line.productItemId),
        );
        return {
          movementId: movement.id,
          creditWarning: warning,
        };
      },
    );

    // Sau commit: không cái nào được làm mất lần nhận đã xảy ra.
    await this.suppliers.notifyCreditWarning(
      tenantId,
      user.userId,
      request.supplierId,
      creditWarning,
    );
    // Không kiểm tồn thấp: hàng về chỉ làm tồn tăng nên không thể vượt ngưỡng (contract §3 bước 5 có nêu, nhưng quy tắc bắt cạnh không bao giờ bắn khi tăng).
    await this.notifyWaitingOrders(tenantId, request, priced, user.userId);
    if (delivery) {
      const recipients = await this.workshopStaffOf(
        tenantId,
        request.supplierId,
      );
      await this.notifications.notify({
        tenantId,
        recipientIds: [...recipients, delivery.createdById].filter(
          (rid) => rid !== user.userId,
        ),
        referenceId: id,
        ...ProductionRequestNotificationTemplates.deliveryReceived({
          deliveryCode: delivery.code,
          requestCode: request.code,
          locationName: request.location.name,
          receivedQuantity: priced.reduce(
            (sum, p) => sum + p.entry.receivedQuantity,
            0,
          ),
          defectQuantity: priced.reduce((sum, p) => sum + p.defect, 0),
        }),
      });
    }

    const received = await this.findRow(tenantId, id);
    return { ...this.toResponse(received), stockMovementId: movementId };
  }

  /** Dòng phải trỏ tới SKU thật, sản xuất được của shop này (sản phẩm có `isManufacturable`), tối đa một lần cho mỗi (SKU, dòng đơn). Dòng gắn dòng đơn phải khớp SKU của dòng đó, và đơn còn chờ giao. Một query cho SKU, một cho dòng đơn (coding rule 19). */
  private async prepareLines(
    tenantId: string,
    lines: ProductionRequestLineDto[],
    skusAlreadyOnRequest: ReadonlySet<string> = new Set(),
  ): Promise<PreparedLine[]> {
    if (lines.length === 0) {
      throw new BadRequestException({
        code: ErrorCode.PRODUCTION_REQUEST_EMPTY,
        message: 'A production request must have at least one line',
      });
    }
    const seen = new Set<string>();
    for (const line of lines) {
      const key = `${line.productItemId}|${line.orderItemId ?? ''}`;
      if (seen.has(key)) {
        throw new BadRequestException({
          code: ErrorCode.PRODUCTION_REQUEST_DUPLICATE_ITEM,
          message: 'The same SKU is listed twice for the same order line',
        });
      }
      seen.add(key);
    }

    const itemIds = [...new Set(lines.map((line) => line.productItemId))];
    const orderItemIds = [
      ...new Set(
        lines
          .map((line) => line.orderItemId)
          .filter((value): value is string => !!value),
      ),
    ];
    const [items, orderItems] = await Promise.all([
      this.prisma.productItem.findMany({
        where: { tenantId, id: { in: itemIds } },
        select: {
          id: true,
          sku: true,
          itemType: true,
          product: { select: { isManufacturable: true } },
        },
      }),
      orderItemIds.length === 0
        ? Promise.resolve<{ id: string; productItemId: string }[]>([])
        : this.prisma.orderItem.findMany({
            where: {
              id: { in: orderItemIds },
              status: OrderItemStatus.PENDING,
              order: {
                tenantId,
                status: { in: [...UNSHIPPED_ORDER_STATUSES] },
                fulfillmentType: { not: FulfillmentType.TAKEAWAY },
              },
            },
            select: { id: true, productItemId: true },
          }),
    ]);
    const itemById = new Map(items.map((item) => [item.id, item]));
    const orderItemById = new Map(orderItems.map((row) => [row.id, row]));

    return lines.map((line) => {
      const item = itemById.get(line.productItemId);
      if (!item) {
        throw new NotFoundException({
          code: ErrorCode.PRODUCT_ITEM_NOT_FOUND,
          message: 'Product variant not found',
        });
      }
      if (!holdsStock(item.itemType)) {
        throw new BadRequestException({
          code: ErrorCode.PRODUCTION_REQUEST_ITEM_NOT_PRODUCIBLE,
          message: `${item.sku ?? item.id} is a ${item.itemType}; only a product can be made (order a combo's components instead)`,
        });
      }
      // Chỉ chặn dòng mới: dòng đã nằm trong YCSX trước khi cờ bị tắt vẫn được giữ và nhận hàng.
      const isNewLine = !skusAlreadyOnRequest.has(item.id);
      if (isNewLine && !item.product.isManufacturable) {
        throw new BadRequestException({
          code: ErrorCode.PRODUCTION_REQUEST_ITEM_NOT_MANUFACTURABLE,
          message: `${item.sku ?? item.id} is not manufacturable; order it from a supplier instead`,
        });
      }
      if (line.orderItemId) {
        const orderItem = orderItemById.get(line.orderItemId);
        if (!orderItem || orderItem.productItemId !== line.productItemId) {
          throw new BadRequestException({
            code: ErrorCode.PRODUCTION_REQUEST_ORDER_ITEM_INVALID,
            message:
              'The order line does not exist, is for another SKU, or has already shipped',
          });
        }
      }
      return {
        productItemId: line.productItemId,
        quantity: line.quantity,
        orderItemId: line.orderItemId ?? null,
        note: line.note ?? null,
        attachmentUrls: line.attachmentUrls ?? [],
      };
    });
  }

  /**
   * Dòng đổi thuộc tính hoặc giá (2026-10-16): chuyển dòng sang SKU đúng bộ thuộc tính (`ProductVariantService`), có thể tạo SKU mới.
   * Chạy sau `prepareLines`, nên SKU gốc đã được kiểm trước khi tạo gì. Dòng làm cho dòng đơn thì không được đổi: thứ được làm do dòng đơn quyết định.
   */
  private async applyVariants(
    user: AuthUser,
    tenantId: string,
    lines: ProductionRequestLineDto[],
    prepared: PreparedLine[],
  ): Promise<PreparedLine[]> {
    const result: PreparedLine[] = [];
    for (const [index, line] of lines.entries()) {
      const changes = line.attributeValues ?? [];
      if (changes.length === 0 && line.retailPrice === undefined) {
        result.push(prepared[index]);
        continue;
      }
      if (line.orderItemId) {
        throw new BadRequestException({
          code: ErrorCode.PRODUCTION_REQUEST_LINE_FIXED_BY_ORDER,
          message:
            "A line made for an order line follows that line's customization; its attributes and price cannot be changed here",
        });
      }
      const resolved = await this.variants.resolve(
        user,
        tenantId,
        line.productItemId,
        changes,
        line.retailPrice,
      );
      result.push({
        ...prepared[index],
        productItemId: resolved.productItemId,
      });
    }
    return result;
  }

  /** Xưởng giao tới đâu: một địa điểm đang hoạt động, bán được, của shop này, và người thao tác được làm việc tại đó. */
  private async requireReceivingLocation(
    user: AuthUser,
    tenantId: string,
    locationId: string,
  ) {
    const location = await this.prisma.location.findFirst({
      where: { id: locationId, tenantId },
      select: { id: true, type: true, status: true, isSellable: true },
    });
    if (!location || location.status === LocationStatus.DELETED) {
      throw new NotFoundException({
        code: ErrorCode.LOCATION_NOT_FOUND,
        message: 'Location not found',
      });
    }
    if (!location.isSellable) {
      throw new BadRequestException({
        code: ErrorCode.LOCATION_NOT_SELLABLE,
        message:
          'A workshop cannot deliver to a damaged-goods location; choose a branch or warehouse that sells',
      });
    }
    if (!canActAt(user, location)) throw this.locationDenied();
    return location;
  }

  /** Hàng lỗi về địa điểm được chỉ định, nếu không thì về kho hàng hỏng của địa điểm nhận; dù thế nào cũng phải là kho của shop này và không bán được. */
  private async resolveDefectLocation(
    tenantId: string,
    request: RequestRow,
    requested: string | undefined,
  ): Promise<string> {
    let targetId = requested;
    if (!targetId) {
      const receiving = await this.prisma.location.findFirst({
        where: { id: request.locationId, tenantId },
        select: { damagedLocationId: true },
      });
      targetId = receiving?.damagedLocationId ?? undefined;
    }
    if (!targetId) {
      throw new BadRequestException({
        code: ErrorCode.LOCATION_DAMAGED_REQUIRED,
        message:
          'The receiving location has no damaged-goods location; name one (defectLocationId) to put the defective units in',
      });
    }
    const target = await this.prisma.location.findFirst({
      where: { id: targetId, tenantId },
      select: { isSellable: true },
    });
    if (!target) {
      throw new NotFoundException({
        code: ErrorCode.LOCATION_NOT_FOUND,
        message: 'Location not found',
      });
    }
    if (target.isSellable) {
      throw new BadRequestException({
        code: ErrorCode.LOCATION_DAMAGED_INVALID,
        message:
          'Defective units must go to a damaged-goods (non-sellable) location',
      });
    }
    return targetId;
  }

  /** Người phụ trách các đơn đang chờ hàng vừa về (cùng địa điểm, chưa giao) được báo là có thể đóng gói. Một query cho mọi SKU về. */
  private async notifyWaitingOrders(
    tenantId: string,
    request: RequestRow,
    priced: { line: RequestRow['items'][number]; good: number }[],
    actorId: string,
  ): Promise<void> {
    const arrived = priced.filter((p) => p.good > 0);
    if (arrived.length === 0) return;
    const waiting = await this.prisma.orderItem.findMany({
      where: {
        sourceLocationId: request.locationId,
        productItemId: { in: arrived.map((p) => p.line.productItemId) },
        status: OrderItemStatus.PENDING,
        order: {
          tenantId,
          status: { in: [...UNSHIPPED_ORDER_STATUSES] },
          assigneeId: { not: null },
        },
      },
      select: { productItemId: true, order: { select: { assigneeId: true } } },
    });
    for (const p of arrived) {
      const recipients = waiting
        .filter((row) => row.productItemId === p.line.productItemId)
        .map((row) => row.order.assigneeId!)
        .filter((id) => id !== actorId);
      if (recipients.length === 0) continue;
      await this.notifications.notify({
        tenantId,
        recipientIds: recipients,
        referenceId: p.line.productItemId,
        ...ProductionRequestNotificationTemplates.goodsArrived({
          label: p.line.productItem.sku ?? p.line.productItem.productName,
          quantity: p.good,
          locationName: request.location.name,
          locationId: request.locationId,
          productItemId: p.line.productItemId,
          requestCode: request.code,
        }),
      });
    }
  }

  private assertCanRead(user: AuthUser, request: RequestRow): void {
    const readable = this.productionList.readableLocations(user);
    if (readable && !readable.includes(request.locationId)) {
      throw this.locationDenied();
    }
  }

  assertCanWrite(user: AuthUser, request: RequestRow): void {
    if (!canActAt(user, request.location)) throw this.locationDenied();
  }

  /** Tài khoản nhân viên đang hoạt động gắn với xưởng – những người nhận thông báo phiếu giao của xưởng. */
  async workshopStaffOf(
    tenantId: string,
    workshopId: string,
  ): Promise<string[]> {
    const staff = await this.prisma.user.findMany({
      where: {
        tenantId,
        workshopId,
        systemRole: SystemRole.STAFF,
        status: UserStatus.ACTIVE,
      },
      select: { id: true },
    });
    return staff.map((row) => row.id);
  }

  deliveryNotPending() {
    return new ConflictException({
      code: ErrorCode.PRODUCTION_DELIVERY_STATUS_INVALID,
      message:
        'This delivery note is no longer waiting to be received (already received or cancelled)',
    });
  }

  private assertDraft(request: RequestRow): void {
    if (request.status !== ProductionRequestStatus.DRAFT) {
      throw this.violation(this.lockedViolation());
    }
  }

  private lockedViolation(): RuleViolation {
    return {
      code: ErrorCode.PRODUCTION_REQUEST_LOCKED,
      message: 'Only a DRAFT production request can be edited or deleted',
    };
  }

  private violation(rule: RuleViolation) {
    return rule.code === ErrorCode.PRODUCTION_REQUEST_HAS_RECEIPTS ||
      rule.code === ErrorCode.PRODUCTION_REQUEST_LOCKED
      ? new ConflictException(rule)
      : new BadRequestException(rule);
  }

  private qtyExceeds(line: RequestRow['items'][number]) {
    return new BadRequestException({
      code: ErrorCode.IMPORT_PRODUCTION_QTY_EXCEEDS,
      message: `More would be received for ${line.productItem.sku ?? line.productItemId} than the ${line.quantity} ordered`,
    });
  }

  private locationDenied() {
    return new ForbiddenException({
      code: ErrorCode.PRODUCTION_REQUEST_LOCATION_DENIED,
      message:
        'You can only work on production requests delivering to your own location',
    });
  }

  async findRow(tenantId: string, id: string): Promise<RequestRow> {
    const request = await this.prisma.productionRequest.findFirst({
      where: { id, tenantId },
      include: DETAIL_INCLUDE,
    });
    if (!request) {
      throw new NotFoundException({
        code: ErrorCode.PRODUCTION_REQUEST_NOT_FOUND,
        message: 'Production request not found',
      });
    }
    return request;
  }

  /** `YYYY-MM-DD` → nửa đêm UTC mà cột `@db.Date` lưu. */
  private dateOrNull(value: string | null | undefined): Date | null {
    return value ? new Date(`${value}T00:00:00.000Z`) : null;
  }

  /** P2002 trên chỉ mục mã – va chạm duy nhất mà `create` thử lại. Lỗi khác là lỗi thật, đi tới AllExceptionsFilter như thường. */
  private isCodeCollision(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    );
  }

  /** Hình dạng `ProductionRequest` theo contract: NCC và địa điểm nêu một lần, người lồng vào, các lần nhận (phiếu nhập WORKSHOP) gom từ các dòng. */
  toResponse(request: RequestRow) {
    const {
      supplierId,
      locationId,
      createdById,
      statusUpdatedById,
      tenantId,
      createdBy,
      statusUpdatedBy,
      items,
      deliveries,
      ...rest
    } = request;

    // Xưởng báo nhưng chưa đếm – phiếu giao kế tiếp phải chừa chỗ cho phần này.
    const pendingByLine = new Map<string, number>();
    for (const delivery of deliveries) {
      if (delivery.status !== ProductionDeliveryStatus.PENDING) continue;
      for (const line of delivery.items) {
        pendingByLine.set(
          line.productionRequestItemId,
          (pendingByLine.get(line.productionRequestItemId) ?? 0) +
            line.quantity,
        );
      }
    }

    const receipts = new Map<
      string,
      {
        stockMovementId: string;
        receivedAt: Date | null;
        receivedBy: ReturnType<typeof withNestedProfile> | null;
      }
    >();
    for (const line of items) {
      for (const { request: movement } of line.importLines) {
        receipts.set(movement.id, {
          stockMovementId: movement.id,
          receivedAt: movement.receivedAt,
          receivedBy: movement.receivedBy
            ? withNestedProfile(movement.receivedBy)
            : null,
        });
      }
    }

    return {
      ...rest,
      // COMPLETED mà còn hàng chưa giao = đã đóng thiếu bằng tay; phần còn lại thôi được tính là đang đặt.
      closedShort:
        rest.status === ProductionRequestStatus.COMPLETED &&
        items.some((line) => line.receivedQuantity < line.quantity),
      createdBy: createdBy ? withNestedProfile(createdBy) : null,
      statusUpdatedBy: statusUpdatedBy
        ? withNestedProfile(statusUpdatedBy)
        : null,
      items: items.map((line) => ({
        id: line.id,
        productItemId: line.productItemId,
        productId: line.productItem.productId,
        sku: line.productItem.sku,
        productName: line.productItem.productName,
        retailPrice: Number(line.productItem.retailPrice),
        attributes: line.productItem.details.map(
          ({ attributeId, name, value }) => ({
            attributeId,
            name,
            value,
          }),
        ),
        imageUrl: thumbnailOf(
          line.productItem.images,
          line.productItem.product.images,
        ),
        quantity: line.quantity,
        receivedQuantity: line.receivedQuantity,
        pendingDeliveryQuantity: pendingByLine.get(line.id) ?? 0,
        note: line.note,
        attachmentUrls: line.attachmentUrls,
        orderItem: line.orderItem
          ? {
              id: line.orderItem.id,
              orderId: line.orderItem.orderId,
              orderCode: line.orderItem.order.code,
              isCustom: line.orderItem.isCustom,
              customization: line.orderItem.customization,
            }
          : null,
      })),
      receipts: [...receipts.values()].sort(
        (a, b) =>
          (a.receivedAt?.getTime() ?? 0) - (b.receivedAt?.getTime() ?? 0),
      ),
      deliveries: deliveries.map(({ createdBy: by, receivedBy, ...d }) => ({
        ...d,
        createdBy: withNestedProfile(by),
        receivedBy: receivedBy ? withNestedProfile(receivedBy) : null,
      })),
    };
  }
}
