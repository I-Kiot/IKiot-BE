import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { InventoryService } from '../inventories/inventories.service';
import { actualStockOf } from '../inventories/low-stock';
import { NotificationService } from '../notifications/notifications.service';
import { StockMovementNotificationTemplates } from '../notifications/templates/stock-movement.templates';
import { SupplierService } from '../suppliers/suppliers.service';
import {
  LOCATION_SELECT,
  resolveLocations,
} from '../../common/dto/location-ref.dto';
import type { LocationEnd } from '../../common/dto/location-ref.dto';
import { isReturnDirection } from '../../common/constants/location-type';
import {
  ImportSource,
  InventoryRefType,
  InventoryTxType,
  LotSourceType,
} from '../../common/constants/inventory-ledger';
import { paginate, skipFor } from '../../common/utils/pagination';
import type { AuthUser } from '../../common/types/auth-user.type';
import {
  canActAt,
  isPostedAt,
  postingOf,
} from '../../common/utils/location-access';
import {
  FINAL_MOVEMENT_STATUSES,
  MovementStatus,
  MovementType,
} from './stock-movement.constants';
import {
  CreateStockMovementDto,
  MovementItemDto,
  QueryStockMovementDto,
  ReceiveMovementDto,
  UpdateMovementDetailsDto,
} from './dto/stock-movement.dto';
import type { Inventory, Prisma } from '../../../generated/prisma/client';
import { ErrorCode } from '../../common/errors/error-codes';
import { SupplierDebtRefType } from '../../common/constants/supplier-debt';
import { toDong } from '../../common/utils/money';
import { withNestedProfile } from '../../common/utils/user-profile';
import { assertHoldsStock } from '../inventories/stockable';

/** Người trong payload của phiếu: nested qua `withNestedProfile` ở `toResponse`. */
const PERSON_SELECT = {
  id: true,
  phoneNumber: true,
  email: true,
  profileFirstName: true,
  profileLastName: true,
} as const;

const DETAIL_INCLUDE = {
  details: {
    select: {
      id: true,
      productItemId: true,
      quantity: true,
      importPrice: true,
      receivedQuantity: true,
      // Số lỗi của phiếu nhập xưởng.
      defectQuantity: true,
      note: true,
      productItem: {
        select: {
          id: true,
          sku: true,
          productName: true,
          productCode: true,
          itemType: true,
        },
      },
    },
  },
  fromSupplier: { select: { id: true, supplierName: true } },
  fromLocation: LOCATION_SELECT,
  toLocation: LOCATION_SELECT,
  createdBy: { select: PERSON_SELECT },
  // Ai đã mở / xuất / nhận / duyệt / huỷ phiếu: các cột này chỉ do chính bước đó ghi (xem `claim`).
  shippedBy: { select: PERSON_SELECT },
  receivedBy: { select: PERSON_SELECT },
  approvedBy: { select: PERSON_SELECT },
  cancelledBy: { select: PERSON_SELECT },
} as const satisfies Prisma.StockMovementRequestInclude;

type MovementRow = Prisma.StockMovementRequestGetPayload<{
  include: typeof DETAIL_INCLUDE;
}>;

/** Service phiếu kho: tồn và trạng thái đổi chung transaction. */
@Injectable()
export class StockMovementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly notifications: NotificationService,
    private readonly suppliers: SupplierService,
  ) {}

  async findAll(user: AuthUser, query: QueryStockMovementDto) {
    const tenantId = this.tenantOf(user);
    const where: Prisma.StockMovementRequestWhereInput = { tenantId };
    if (query.status) where.status = query.status;
    if (query.movementType) where.movementType = query.movementType;
    if (query.importSource) where.importSource = query.importSource;

    // Tài khoản nhân viên thấy phiếu chạm tới địa điểm của mình, ở cả hai đầu.
    const own = this.postingOf(user);
    if (own) {
      if (!own.locationId) {
        // Không được phân công nơi nào: so khớp trực tiếp cột sẽ âm thầm khớp các dòng null.
        return paginate([], 0, query.page, query.limit);
      }
      where.OR = [
        { fromLocationId: own.locationId },
        { toLocationId: own.locationId },
      ];
    }

    const [rows, total] = await Promise.all([
      this.prisma.stockMovementRequest.findMany({
        where,
        include: DETAIL_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip: skipFor(query.page, query.limit),
        take: query.limit,
      }),
      this.prisma.stockMovementRequest.count({ where }),
    ]);

    return paginate(
      rows.map((row) => this.toResponse(row)),
      total,
      query.page,
      query.limit,
    );
  }

  async findOne(user: AuthUser, id: string) {
    const request = await this.findRow(this.tenantOf(user), id);
    // Xem được từ cả hai đầu: bên gửi và bên nhận đều cần thấy.
    if (
      !this.canActAt(user, this.source(request)) &&
      !this.canActAt(user, this.destination(request))
    ) {
      throw new ForbiddenException({
        code: ErrorCode.STOCK_MOVEMENT_READ_DENIED,
        message: 'You are not allowed to view this stock movement',
      });
    }
    return this.toResponse(request);
  }

  async create(user: AuthUser, dto: CreateStockMovementDto) {
    const tenantId = this.tenantOf(user);
    this.assertNoDuplicateItems(dto.details);

    // Kiểm hai đầu phiếu trong một truy vấn.
    const fromId = this.resolveSourceId(user, dto);
    const ends = await resolveLocations(this.prisma, tenantId, [
      fromId,
      dto.toLocationId,
    ]);
    const from = fromId ? ends.get(fromId)! : null;
    const to = dto.toLocationId ? ends.get(dto.toLocationId)! : null;
    // IMPORT không có nguồn nên lọc theo đích; bỏ qua thì nhân viên có thể nhập hàng vào kho bất kỳ.
    if (dto.movementType === MovementType.IMPORT) {
      if (to) this.assertCanActAt(user, to);
    } else if (this.isTransferType(dto.movementType)) {
      // Bên gửi hoặc bên nhận đều tạo được phiếu chuyển.
      if (!this.canActAt(user, from) && !this.canActAt(user, to)) {
        throw new ForbiddenException({
          code: ErrorCode.STOCK_MOVEMENT_LOCATION_DENIED,
          message:
            'A transfer must be raised from either its source or its destination',
        });
      }
    } else if (from) {
      // ADJUST đếm tồn tại một nơi, nên chỉ lập tại đó.
      this.assertCanActAt(user, from);
    }
    this.assertEndpointsValid(dto.movementType, from, to);

    const details = await this.prepareLines(
      tenantId,
      dto.movementType,
      from,
      dto.details,
    );

    const totalPrice =
      dto.movementType === MovementType.ADJUST ? 0 : this.totalOf(details);

    if (dto.movementType === MovementType.IMPORT) {
      // Hàng của xưởng chỉ về qua yêu cầu sản xuất (contract §3).
      const supplier = await this.suppliers.requireForImport(
        tenantId,
        dto.fromSupplierId,
        ImportSource.SUPPLIER,
      );
      this.suppliers.assertCreditHeadroom(supplier, totalPrice);
    }

    // IMPORT và ADJUST không có gì để chọn và đóng gói, nên mở ở PENDING.
    const status =
      dto.movementType === MovementType.IMPORT ||
      dto.movementType === MovementType.ADJUST
        ? MovementStatus.PENDING
        : MovementStatus.DRAFT;

    const created = await this.prisma.stockMovementRequest.create({
      data: {
        tenantId,
        movementType: dto.movementType,
        // Phiếu nhập phải có nguồn.
        importSource:
          dto.movementType === MovementType.IMPORT
            ? ImportSource.SUPPLIER
            : null,
        status,
        note: dto.note,
        createdById: user.userId,
        totalPrice,
        fromSupplierId: dto.fromSupplierId,
        fromLocationId: from?.id ?? null,
        toLocationId: to?.id ?? null,
        details: { create: details },
      },
      include: DETAIL_INCLUDE,
    });

    // Báo bên gửi khi bên nhận xin hàng.
    const pulledIn =
      this.isTransferType(created.movementType) &&
      this.isPostedAt(user, this.destination(created)) &&
      !this.isPostedAt(user, this.source(created));

    await this.notifyMovement(created, user.userId, {
      ...(pulledIn
        ? StockMovementNotificationTemplates.requested(created.id)
        : StockMovementNotificationTemplates.created(
            created.id,
            created.movementType,
          )),
      // Import do nơi nhận chờ; chuyển do nơi gửi xử lý.
      notifyFrom: created.movementType !== MovementType.IMPORT,
      notifyTo: created.movementType === MovementType.IMPORT,
    });

    return this.toResponse(created);
  }

  /** Thay các dòng. Chỉ được khi phiếu còn đang soạn. */
  async updateDetails(
    user: AuthUser,
    id: string,
    dto: UpdateMovementDetailsDto,
  ) {
    const tenantId = this.tenantOf(user);
    const request = await this.findRow(tenantId, id);
    this.assertNoDuplicateItems(dto.details);

    const isTransfer = this.isTransferType(request.movementType);

    if (isTransfer) {
      this.assertStatus(request, [MovementStatus.OPENING]);
      // Hai đầu vẫn sửa được danh sách khi phiếu còn mở.
      if (
        !this.canActAt(user, this.source(request)) &&
        !this.canActAt(user, this.destination(request))
      ) {
        throw new ForbiddenException({
          code: ErrorCode.STOCK_MOVEMENT_WRITE_DENIED,
          message: 'You are not allowed to edit this stock movement',
        });
      }
    } else {
      this.assertStatus(request, [MovementStatus.PENDING]);
      const end =
        request.movementType === MovementType.IMPORT
          ? this.destination(request)
          : this.source(request);
      this.assertCanActAt(user, end);
    }

    const details = await this.prepareLines(
      tenantId,
      request.movementType,
      this.source(request),
      dto.details,
    );

    const totalPrice =
      request.movementType === MovementType.ADJUST ? 0 : this.totalOf(details);

    if (request.movementType === MovementType.IMPORT) {
      const supplier = await this.suppliers.requireForImport(
        tenantId,
        request.fromSupplierId,
        ImportSource.SUPPLIER,
      );
      this.suppliers.assertCreditHeadroom(supplier, totalPrice);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      // Chiếm phiếu trước khi thay dòng.
      await this.claim(tx, tenantId, id, [request.status], { totalPrice });
      await tx.stockMovementRequestItem.deleteMany({
        where: { requestId: id },
      });
      return tx.stockMovementRequest.update({
        where: { id },
        data: { details: { create: details } },
        include: DETAIL_INCLUDE,
      });
    });

    return this.toResponse(updated);
  }

  /** DRAFT → OPENING: nơi gửi bắt đầu soạn hàng. */
  async open(user: AuthUser, id: string) {
    const request = await this.findRow(this.tenantOf(user), id);
    this.assertCanActAt(user, this.source(request));
    this.assertStatus(request, [MovementStatus.DRAFT]);
    await this.assertSourceStock(this.prisma, request);

    return this.toResponse(
      await this.setStatus(
        this.tenantOf(user),
        id,
        [MovementStatus.DRAFT],
        MovementStatus.OPENING,
      ),
    );
  }

  /** OPENING → CLOSED: soạn xong, danh sách chốt. */
  async close(user: AuthUser, id: string) {
    const request = await this.findRow(this.tenantOf(user), id);
    this.assertCanActAt(user, this.source(request));
    this.assertStatus(request, [MovementStatus.OPENING]);
    if (request.details.length === 0) {
      throw new BadRequestException({
        code: ErrorCode.STOCK_MOVEMENT_EMPTY,
        message: 'A stock movement with no items cannot be closed',
      });
    }
    await this.assertSourceStock(this.prisma, request);

    return this.toResponse(
      await this.setStatus(
        this.tenantOf(user),
        id,
        [MovementStatus.OPENING],
        MovementStatus.CLOSED,
      ),
    );
  }

  /** → IN_TRANSIT: hàng rời kho thật, nên trừ nguồn và đổi trạng thái chung một transaction. */
  async ship(user: AuthUser, id: string) {
    const tenantId = this.tenantOf(user);
    const request = await this.findRow(tenantId, id);
    this.assertCanActAt(user, this.source(request));
    this.assertStatus(request, [MovementStatus.CLOSED, MovementStatus.PENDING]);
    // Lý do như `receive`, sớm hơn: hàng rời nguồn tại đây, và dòng combo sau đó không bao giờ nhận được.
    assertHoldsStock(request.details.map((line) => line.productItem));

    const isTransfer = this.isTransferType(request.movementType);

    const { shipped, crossings } = await this.prisma.$transaction(
      async (tx) => {
        // Chiếm phiếu trước khi trừ kho: hai lần "xuất" cùng lúc thì chỉ một lần trừ.
        await this.claim(
          tx,
          tenantId,
          id,
          [MovementStatus.CLOSED, MovementStatus.PENDING],
          {
            status: MovementStatus.IN_TRANSIT,
            shippedById: user.userId,
            shippedAt: new Date(),
          },
        );
        const lowStock: (Inventory | null)[] = [];

        if (isTransfer) {
          const from = this.source(request)!;
          for (const line of request.details) {
            const quantity = Number(line.quantity);
            // Trừ tồn có kiểm tra.
            const after = await this.inventory.deductStock(tx, {
              tenantId,
              productItemId: line.productItemId,
              locationId: from.id,
              quantity,
              label: line.productItem.sku ?? line.productItemId,
              ledger: {
                type: InventoryTxType.TRANSFER_OUT,
                referenceType: InventoryRefType.STOCK_MOVEMENT,
                referenceId: request.id,
                createdById: user.userId,
              },
            });
            lowStock.push(this.inventory.lowStockCrossing(after, -quantity));
          }
        }

        return {
          shipped: await this.reload(tx, id),
          crossings: lowStock,
        };
      },
    );

    await this.inventory.notifyLowStock(crossings);
    await this.notifyMovement(shipped, user.userId, {
      ...StockMovementNotificationTemplates.inTransit(shipped.id),
      notifyTo: true,
    });

    return this.toResponse(shipped);
  }

  /** Nhận hàng: tăng tồn theo số thực nhận; phiếu nhập thì tăng công nợ NCC. */
  async receive(user: AuthUser, id: string, dto: ReceiveMovementDto) {
    const tenantId = this.tenantOf(user);
    const request = await this.findRow(tenantId, id);
    this.assertCanActAt(user, this.destination(request));
    this.assertStatus(
      request,
      request.movementType === MovementType.IMPORT
        ? [MovementStatus.PENDING, MovementStatus.IN_TRANSIT]
        : [MovementStatus.IN_TRANSIT],
    );
    // Chặn combo / dịch vụ.
    assertHoldsStock(request.details.map((line) => line.productItem));

    const receivedByItem = new Map(
      dto.details.map((line) => [line.productItemId, line.receivedQuantity]),
    );
    const missing = request.details.find(
      (line) => !receivedByItem.has(line.productItemId),
    );
    if (missing) {
      throw new BadRequestException({
        code: ErrorCode.STOCK_MOVEMENT_RECEIVED_QTY_REQUIRED,
        message: `The received quantity is missing for ${missing.productItem.sku ?? missing.productItemId}`,
      });
    }

    // Không nhận quá số đã gửi.
    const over = request.details.find(
      (line) =>
        (receivedByItem.get(line.productItemId) ?? 0) > Number(line.quantity),
    );
    if (over) {
      throw new BadRequestException({
        code: ErrorCode.STOCK_MOVEMENT_RECEIVED_QTY_EXCEEDS,
        message: `The received quantity for ${over.productItem.sku ?? over.productItemId} exceeds the ${Number(over.quantity)} on the movement`,
      });
    }

    const totalReceived = [...receivedByItem.values()].reduce(
      (sum, quantity) => sum + quantity,
      0,
    );
    if (totalReceived === 0) {
      throw new BadRequestException({
        code: ErrorCode.STOCK_MOVEMENT_RECEIVE_EMPTY,
        message:
          'An empty receipt is not allowed: at least one item must have a received quantity above 0',
      });
    }

    const to = this.destination(request)!;
    const { received, creditWarning } = await this.prisma.$transaction(
      async (tx) => {
        // Chiếm phiếu trước khi ghi tồn và công nợ.
        await this.claim(
          tx,
          tenantId,
          id,
          request.movementType === MovementType.IMPORT
            ? [MovementStatus.PENDING, MovementStatus.IN_TRANSIT]
            : [MovementStatus.IN_TRANSIT],
          {
            status: MovementStatus.RECEIVED,
            receivedById: user.userId,
            receivedAt: new Date(),
          },
        );
        let importCost = 0;

        for (const line of request.details) {
          const quantity = receivedByItem.get(line.productItemId) ?? 0;
          await tx.stockMovementRequestItem.update({
            where: { id: line.id },
            data: { receivedQuantity: quantity },
          });

          if (quantity <= 0) continue;
          const ledger = {
            referenceType: InventoryRefType.STOCK_MOVEMENT,
            referenceId: request.id,
            createdById: user.userId,
          };
          if (request.movementType === MovementType.IMPORT) {
            importCost += toDong(quantity * Number(line.importPrice ?? 0));
            // Mỗi dòng nhập là một lô theo giá nhập.
            await this.inventory.openLot(tx, {
              tenantId,
              productItemId: line.productItemId,
              locationId: to.id,
              quantity,
              unitCost:
                line.importPrice === null
                  ? undefined
                  : Number(line.importPrice),
              sourceType: LotSourceType.SUPPLIER,
              supplierId: request.fromSupplierId,
              importItemId: line.id,
              ledger: { ...ledger, type: InventoryTxType.IMPORT },
            });
          } else {
            // Hàng chuyển về thành lô con của lô nguồn.
            await this.inventory.returnDrawn(tx, {
              tenantId,
              productItemId: line.productItemId,
              toLocationId: to.id,
              quantity,
              drawnBy: {
                referenceType: InventoryRefType.STOCK_MOVEMENT,
                referenceId: request.id,
              },
              ledger: { ...ledger, type: InventoryTxType.TRANSFER_IN },
              ifNeverDrawn: { sourceType: LotSourceType.OPENING },
            });
          }
        }

        const warning =
          request.movementType === MovementType.IMPORT && request.fromSupplierId
            ? await this.suppliers.charge(
                tx,
                tenantId,
                request.fromSupplierId,
                importCost,
                request.details
                  .filter(
                    (line) => (receivedByItem.get(line.productItemId) ?? 0) > 0,
                  )
                  .map((line) => line.productItemId),
                {
                  actorId: user.userId,
                  type: SupplierDebtRefType.STOCK_MOVEMENT,
                  id: request.id,
                },
              )
            : null;

        return {
          received: await this.reload(tx, id),
          creditWarning: warning,
        };
      },
    );

    if (request.fromSupplierId) {
      await this.suppliers.notifyCreditWarning(
        tenantId,
        user.userId,
        request.fromSupplierId,
        creditWarning,
      );
    }

    await this.notifyMovement(received, user.userId, {
      ...StockMovementNotificationTemplates.received(received.id),
      notifyCreator: true,
      notifyFrom: true,
    });

    return this.toResponse(received);
  }

  /** Áp số kiểm kê; từ chối nếu ra tồn âm. */
  async approveAdjust(user: AuthUser, id: string) {
    const tenantId = this.tenantOf(user);
    const request = await this.findRow(tenantId, id);
    this.assertCanActAt(user, this.source(request));

    if (request.movementType !== MovementType.ADJUST) {
      throw new BadRequestException({
        code: ErrorCode.STOCK_MOVEMENT_NOT_ADJUST,
        message: 'Only a stocktake can be approved this way',
      });
    }
    this.assertStatus(request, [MovementStatus.PENDING]);
    assertHoldsStock(request.details.map((line) => line.productItem));

    const from = this.source(request)!;
    const changes = request.details.map((line) => {
      if (line.receivedQuantity === null) {
        throw new BadRequestException({
          code: ErrorCode.STOCK_MOVEMENT_COUNTED_QTY_REQUIRED,
          message: `The counted quantity is missing for ${line.productItem.sku ?? line.productItemId}`,
        });
      }
      return {
        productItemId: line.productItemId,
        label: line.productItem.sku ?? line.productItemId,
        delta: Number(line.receivedQuantity) - Number(line.quantity),
      };
    });

    if (changes.every((change) => change.delta === 0)) {
      throw new BadRequestException({
        code: ErrorCode.STOCK_MOVEMENT_NO_ADJUSTMENT,
        message:
          'Nothing to adjust: the counted quantity matches the system for every item',
      });
    }

    const { completed, crossings } = await this.prisma.$transaction(
      async (tx) => {
        await this.claim(tx, tenantId, id, [MovementStatus.PENDING], {
          status: MovementStatus.COMPLETED,
          approvedById: user.userId,
          approvedAt: new Date(),
        });
        const lowStock: (Inventory | null)[] = [];

        for (const change of changes) {
          if (change.delta === 0) continue;

          if (change.delta < 0) {
            const current = await tx.inventory.findFirst({
              where: {
                tenantId,
                productItemId: change.productItemId,
                locationId: from.id,
              },
              select: { stock: true },
            });
            const stock = current?.stock ?? 0;
            if (stock + change.delta < 0) {
              throw new BadRequestException({
                code: ErrorCode.STOCK_MOVEMENT_ADJUST_NEGATIVE,
                message: `The adjustment takes ${change.label} below 0 in stock (${stock} on hand, adjustment ${change.delta})`,
              });
            }
          }

          // Thừa thì mở lô mới, thiếu thì rút lô FIFO.
          const key = {
            tenantId,
            productItemId: change.productItemId,
            locationId: from.id,
          };
          const ledger = {
            type: InventoryTxType.ADJUST,
            referenceType: InventoryRefType.STOCK_MOVEMENT,
            referenceId: request.id,
            createdById: user.userId,
          };
          const after =
            change.delta > 0
              ? (
                  await this.inventory.openLot(tx, {
                    ...key,
                    quantity: change.delta,
                    sourceType: LotSourceType.ADJUSTMENT,
                    ledger,
                  })
                ).inventory
              : await this.inventory.deductStock(tx, {
                  ...key,
                  quantity: -change.delta,
                  label: change.label,
                  ledger,
                });
          lowStock.push(this.inventory.lowStockCrossing(after, change.delta));
        }

        return {
          completed: await this.reload(tx, id),
          crossings: lowStock,
        };
      },
    );

    await this.inventory.notifyLowStock(crossings);
    return this.toResponse(completed);
  }

  /** Huỷ phiếu, trả lại hàng đã rời kho. */
  async cancel(user: AuthUser, id: string) {
    const tenantId = this.tenantOf(user);
    const request = await this.findRow(tenantId, id);

    // Hai đầu đều huỷ được.
    if (
      !this.canActAt(user, this.source(request)) &&
      !this.canActAt(user, this.destination(request))
    ) {
      throw new ForbiddenException({
        code: ErrorCode.STOCK_MOVEMENT_CANCEL_DENIED,
        message: 'You are not allowed to cancel this stock movement',
      });
    }
    if (FINAL_MOVEMENT_STATUSES.includes(request.status)) {
      throw new ConflictException({
        code: ErrorCode.STOCK_MOVEMENT_CANCEL_STATUS_INVALID,
        message: `A stock movement cannot be cancelled while it is ${request.status}`,
      });
    }

    const shouldReturnStock =
      request.status === MovementStatus.IN_TRANSIT &&
      this.isTransferType(request.movementType);

    const cancelled = await this.prisma.$transaction(async (tx) => {
      // Chiếm phiếu trước khi trả hàng về nguồn.
      await this.claim(tx, tenantId, id, [request.status], {
        status: MovementStatus.CANCELLED,
        cancelledAt: new Date(),
        cancelledById: user.userId,
      });
      if (shouldReturnStock) {
        const from = this.source(request)!;
        // Trả về đúng các lô đã rời.
        for (const line of request.details) {
          await this.inventory.returnDrawn(tx, {
            tenantId,
            productItemId: line.productItemId,
            toLocationId: from.id,
            quantity: Number(line.quantity),
            drawnBy: {
              referenceType: InventoryRefType.STOCK_MOVEMENT,
              referenceId: request.id,
            },
            ledger: {
              type: InventoryTxType.TRANSFER_IN,
              referenceType: InventoryRefType.STOCK_MOVEMENT,
              referenceId: request.id,
              createdById: user.userId,
              note: 'Huỷ phiếu đang vận chuyển',
            },
            ifNeverDrawn: { sourceType: LotSourceType.OPENING },
          });
        }
      }

      return this.reload(tx, id);
    });

    await this.notifyMovement(cancelled, user.userId, {
      ...StockMovementNotificationTemplates.cancelled(cancelled.id),
      notifyCreator: true,
      notifyFrom: true,
      notifyTo: true,
    });

    return this.toResponse(cancelled);
  }

  // ─── Chuẩn bị dòng ───

  /** Dòng nhập cần giá và số lượng, giá nhập không vượt giá bán lẻ. */
  private async prepareImportLines(tenantId: string, lines: MovementItemDto[]) {
    const items = await this.itemsById(tenantId, lines);

    return lines.map((line) => {
      const item = items.get(line.productItemId)!;
      if (!line.quantity || line.quantity <= 0) {
        throw new BadRequestException({
          code: ErrorCode.QUANTITY_MUST_BE_POSITIVE,
          message: `The quantity must be greater than 0 for ${item.sku ?? item.id}`,
        });
      }
      if (!line.importPrice || line.importPrice <= 0) {
        throw new BadRequestException({
          code: ErrorCode.IMPORT_PRICE_MUST_BE_POSITIVE,
          message: `The import price must be greater than 0 for ${item.sku ?? item.id}`,
        });
      }
      if (line.importPrice > Number(item.retailPrice)) {
        throw new BadRequestException({
          code: ErrorCode.IMPORT_PRICE_ABOVE_RETAIL,
          message: `The import price cannot exceed the retail price (${Number(item.retailPrice)}) for ${item.sku ?? item.id}`,
        });
      }
      return {
        productItemId: line.productItemId,
        quantity: line.quantity,
        importPrice: line.importPrice,
        note: line.note,
      };
    });
  }

  /** Dòng xuất/trả: giá mặc định là giá vốn, nguồn phải đủ hàng. */
  private async prepareTransferLines(
    tenantId: string,
    from: LocationEnd,
    lines: MovementItemDto[],
  ) {
    const items = await this.itemsById(tenantId, lines);

    const prepared = lines.map((line) => {
      const item = items.get(line.productItemId)!;
      if (!line.quantity || line.quantity <= 0) {
        throw new BadRequestException({
          code: ErrorCode.QUANTITY_MUST_BE_POSITIVE,
          message: `The quantity must be greater than 0 for ${item.sku ?? item.id}`,
        });
      }
      return {
        productItemId: line.productItemId,
        quantity: line.quantity,
        importPrice: line.importPrice ?? Number(item.costPrice),
        note: line.note,
      };
    });

    await this.assertStockCovers(this.prisma, tenantId, from, prepared);
    return prepared;
  }

  /** Dòng kiểm kê: số kiểm đếm và số hệ thống. */
  private async prepareAdjustLines(
    tenantId: string,
    from: LocationEnd,
    lines: MovementItemDto[],
  ) {
    const items = await this.itemsById(tenantId, lines);
    const stock = await this.prisma.inventory.findMany({
      where: {
        tenantId,
        locationId: from.id,
        productItemId: { in: lines.map((line) => line.productItemId) },
      },
      select: { productItemId: true, stock: true },
    });
    const stockByItem = new Map(
      stock.map((row) => [row.productItemId, row.stock]),
    );

    return lines.map((line) => {
      const item = items.get(line.productItemId)!;
      if (line.receivedQuantity === undefined) {
        throw new BadRequestException({
          code: ErrorCode.STOCK_MOVEMENT_COUNTED_QTY_REQUIRED,
          message: `A counted quantity is required for ${item.sku ?? item.id}`,
        });
      }
      return {
        productItemId: line.productItemId,
        quantity: line.quantity ?? stockByItem.get(line.productItemId) ?? 0,
        receivedQuantity: line.receivedQuantity,
        note: line.note,
      };
    });
  }

  private async itemsById(tenantId: string, lines: MovementItemDto[]) {
    const ids = [...new Set(lines.map((line) => line.productItemId))];
    const items = await this.prisma.productItem.findMany({
      where: { tenantId, id: { in: ids } },
      select: {
        id: true,
        sku: true,
        retailPrice: true,
        costPrice: true,
        itemType: true,
      },
    });
    if (items.length !== ids.length) {
      throw new NotFoundException({
        code: ErrorCode.PRODUCT_ITEM_NOT_FOUND,
        message: 'Product item not found',
      });
    }
    // Đọc dòng phiếu.
    assertHoldsStock(items);
    return new Map(items.map((item) => [item.id, item]));
  }

  // ─── Kiểm tra ───

  private assertNoDuplicateItems(lines: MovementItemDto[]): void {
    const ids = lines.map((line) => line.productItemId);
    if (new Set(ids).size !== ids.length) {
      throw new BadRequestException({
        code: ErrorCode.STOCK_MOVEMENT_DUPLICATE_ITEM,
        message: 'An item may appear only once on a stock movement',
      });
    }
  }

  private assertStatus(request: MovementRow, allowed: readonly string[]): void {
    if (!allowed.includes(request.status)) {
      throw new ConflictException({
        code: ErrorCode.STOCK_MOVEMENT_STATUS_INVALID,
        message: `This action is only valid while the movement is ${allowed.join(' or ')} (currently ${request.status})`,
      });
    }
  }

  /** Kiểm các trường bắt buộc theo loại phiếu. */
  private assertEndpointsValid(
    movementType: string,
    from: LocationEnd | null,
    to: LocationEnd | null,
  ): void {
    if (movementType === MovementType.IMPORT) {
      if (!to)
        throw new BadRequestException({
          code: ErrorCode.STOCK_MOVEMENT_DESTINATION_REQUIRED,
          message: 'An import must have a destination location',
        });
    } else {
      if (!from)
        throw new BadRequestException({
          code: ErrorCode.STOCK_MOVEMENT_SOURCE_REQUIRED,
          message: 'This movement must have a source location',
        });
      if (movementType === MovementType.ADJUST) {
        // Kiểm kê không có nơi nhận.
        if (to) {
          throw new BadRequestException({
            code: ErrorCode.STOCK_MOVEMENT_ADJUST_HAS_DESTINATION,
            message: 'A stocktake has no destination location',
          });
        }
      } else {
        if (!to)
          throw new BadRequestException({
            code: ErrorCode.STOCK_MOVEMENT_DESTINATION_REQUIRED,
            message: 'This movement must have a destination location',
          });
        this.assertTransferMakesSense(movementType, from, to);
      }
    }
  }

  /** Dựng dòng theo loại phiếu. */
  private async prepareLines(
    tenantId: string,
    movementType: string,
    from: LocationEnd | null,
    lines: MovementItemDto[],
  ) {
    if (movementType === MovementType.IMPORT) {
      return this.prepareImportLines(tenantId, lines);
    }
    if (!from)
      throw new BadRequestException({
        code: ErrorCode.STOCK_MOVEMENT_SOURCE_REQUIRED,
        message: 'This movement must have a source location',
      });
    return movementType === MovementType.ADJUST
      ? this.prepareAdjustLines(tenantId, from, lines)
      : this.prepareTransferLines(tenantId, from, lines);
  }

  /** Phiếu chuyển phải đến nơi khác; chiều trả hàng thì dùng RETURN. */
  private assertTransferMakesSense(
    movementType: string,
    from: LocationEnd,
    to: LocationEnd,
  ): void {
    if (from.id === to.id) {
      throw new BadRequestException({
        code: ErrorCode.STOCK_MOVEMENT_SAME_LOCATION,
        message: 'The source and destination locations must be different',
      });
    }
    if (
      movementType === MovementType.EXPORT &&
      isReturnDirection(from.type, to.type)
    ) {
      throw new BadRequestException({
        code: ErrorCode.STOCK_MOVEMENT_SHOULD_BE_RETURN,
        message:
          'Moving stock from a branch back to a warehouse must use a RETURN, not an EXPORT',
      });
    }
  }

  /** Nguồn phải đủ hàng cho mọi dòng. */
  private async assertSourceStock(
    client: Prisma.TransactionClient | PrismaService,
    request: MovementRow,
  ): Promise<void> {
    if (
      request.movementType !== MovementType.EXPORT &&
      request.movementType !== MovementType.RETURN
    ) {
      return;
    }
    await this.assertStockCovers(
      client,
      request.tenantId,
      this.source(request)!, // phiếu xuất/trả luôn có nguồn
      request.details.map((line) => ({
        productItemId: line.productItemId,
        quantity: Number(line.quantity),
      })),
    );
  }

  private async assertStockCovers(
    client: Prisma.TransactionClient | PrismaService,
    tenantId: string,
    from: LocationEnd,
    lines: { productItemId: string; quantity: number }[],
  ): Promise<void> {
    if (lines.length === 0) return;

    const rows = await client.inventory.findMany({
      where: {
        tenantId,
        locationId: from.id,
        productItemId: { in: lines.map((line) => line.productItemId) },
      },
      select: { productItemId: true, stock: true, lockedStock: true },
    });
    // Chỉ hàng trên kệ được chuyển.
    const stockByItem = new Map(
      rows.map((row) => [row.productItemId, actualStockOf(row)]),
    );

    for (const line of lines) {
      const available = stockByItem.get(line.productItemId) ?? 0;
      if (line.quantity > available) {
        throw new BadRequestException({
          code: ErrorCode.INSUFFICIENT_STOCK,
          message: `A quantity of ${line.quantity} exceeds the ${available} on the shelf at the source location`,
        });
      }
    }
  }

  // ─── Quyền ───

  private tenantOf(user: AuthUser): string {
    if (!user.tenantId) {
      throw new ForbiddenException({
        code: ErrorCode.ACCOUNT_HAS_NO_TENANT,
        message: 'This account does not belong to any shop',
      });
    }
    return user.tenantId;
  }

  /** Nơi nhân viên được gán, null nếu làm được mọi nơi. */
  private postingOf(user: AuthUser): { locationId: string | null } | null {
    return postingOf(user);
  }

  /** Người dùng có được thao tác tại địa điểm này không. */
  private canActAt(user: AuthUser, location: LocationEnd | null): boolean {
    return canActAt(user, location);
  }

  /** Phiếu chuyển giữa hai địa điểm của mình. */
  private isTransferType(movementType: string): boolean {
    return (
      movementType === MovementType.EXPORT ||
      movementType === MovementType.RETURN
    );
  }

  /** Có đúng nơi người dùng làm việc không. */
  private isPostedAt(user: AuthUser, location: LocationEnd | null): boolean {
    return isPostedAt(user, location);
  }

  /** Thiếu địa điểm thì từ chối. */
  private assertCanActAt(user: AuthUser, location: LocationEnd | null): void {
    if (!this.canActAt(user, location)) {
      throw new ForbiddenException({
        code: ErrorCode.STOCK_MOVEMENT_LOCATION_DENIED,
        message: 'You can only work on stock movements at your own location',
      });
    }
  }

  /** Nguồn trừ hàng: nhân viên bỏ trống thì lấy nơi được gán. */
  private resolveSourceId(
    user: AuthUser,
    dto: CreateStockMovementDto,
  ): string | null {
    if (dto.movementType === MovementType.IMPORT) return null;
    if (dto.fromLocationId) return dto.fromLocationId;

    const own = this.postingOf(user);
    if (!own?.locationId) {
      throw new BadRequestException({
        code: ErrorCode.STOCK_MOVEMENT_SOURCE_REQUIRED,
        message: 'This movement must have a source location (fromLocationId)',
      });
    }
    return own.locationId;
  }

  /** Nơi xuất của phiếu, null với phiếu nhập. */
  private source(request: MovementRow): LocationEnd | null {
    return request.fromLocation;
  }

  /** Nơi nhận của phiếu, null với phiếu kiểm kê. */
  private destination(request: MovementRow): LocationEnd | null {
    return request.toLocation;
  }

  // ─── Tiện ích ───

  private async findRow(tenantId: string, id: string): Promise<MovementRow> {
    const request = await this.prisma.stockMovementRequest.findFirst({
      where: { id, tenantId },
      include: DETAIL_INCLUDE,
    });
    if (!request)
      throw new NotFoundException({
        code: ErrorCode.STOCK_MOVEMENT_NOT_FOUND,
        message: 'Stock movement not found',
      });
    return request;
  }

  /** Đổi trạng thái đơn thuần (mở, chốt) bằng lệnh chiếm có điều kiện, trong transaction. */
  private setStatus(
    tenantId: string,
    id: string,
    from: readonly string[],
    status: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      await this.claim(tx, tenantId, id, from, { status });
      return this.reload(tx, id);
    });
  }

  /** Chiếm phiếu theo trạng thái hiện tại, đầu mọi transaction đổi phiếu. */
  private async claim(
    tx: Prisma.TransactionClient,
    tenantId: string,
    id: string,
    from: readonly string[],
    data: Prisma.StockMovementRequestUncheckedUpdateManyInput,
  ): Promise<void> {
    const claimed = await tx.stockMovementRequest.updateMany({
      where: { id, tenantId, status: { in: [...from] } },
      data,
    });
    if (claimed.count !== 1) {
      throw new ConflictException({
        code: ErrorCode.STOCK_MOVEMENT_CONFLICT,
        message:
          'The stock movement has just been changed by someone else, please reload',
      });
    }
  }

  private reload(tx: Prisma.TransactionClient, id: string) {
    return tx.stockMovementRequest.findUniqueOrThrow({
      where: { id },
      include: DETAIL_INCLUDE,
    });
  }

  private totalOf(lines: { quantity: number; importPrice?: number }[]): number {
    return lines.reduce(
      (sum, line) => sum + line.quantity * (line.importPrice ?? 0),
      0,
    );
  }

  /** Báo người liên quan sau khi xong, bỏ người thao tác. */
  private async notifyMovement(
    request: MovementRow,
    actorId: string,
    options: {
      type: string;
      title: string;
      description: string;
      link?: string;
      notifyCreator?: boolean;
      notifyFrom?: boolean;
      notifyTo?: boolean;
    },
  ): Promise<void> {
    const { notifyCreator, notifyFrom, notifyTo, ...content } = options;
    const tenantId = request.tenantId;

    const recipients: string[] = [];
    if (notifyCreator) recipients.push(request.createdById);
    if (notifyFrom) {
      recipients.push(
        ...(await this.notifications.managersOfLocation({
          tenantId,
          locationId: request.fromLocationId,
        })),
      );
    }
    if (notifyTo) {
      recipients.push(
        ...(await this.notifications.managersOfLocation({
          tenantId,
          locationId: request.toLocationId,
        })),
      );
    }

    await this.notifications.notify({
      tenantId,
      recipientIds: recipients.filter((id) => id !== actorId),
      referenceId: request.id,
      ...content,
    });
  }

  /** Đổi phiếu sang dạng response. */
  private toResponse(request: MovementRow) {
    const {
      fromLocationId,
      toLocationId,
      totalPrice,
      details,
      createdBy,
      shippedBy,
      receivedBy,
      approvedBy,
      cancelledBy,
      ...rest
    } = request;

    return {
      ...rest,
      // User lồng `profile`.
      createdBy: createdBy ? withNestedProfile(createdBy) : createdBy,
      shippedBy: shippedBy ? withNestedProfile(shippedBy) : null,
      receivedBy: receivedBy ? withNestedProfile(receivedBy) : null,
      approvedBy: approvedBy ? withNestedProfile(approvedBy) : null,
      cancelledBy: cancelledBy ? withNestedProfile(cancelledBy) : null,
      totalPrice: Number(totalPrice),
      details: details.map((line) => ({
        ...line,
        quantity: Number(line.quantity),
        importPrice:
          line.importPrice === null ? null : Number(line.importPrice),
        receivedQuantity:
          line.receivedQuantity === null ? null : Number(line.receivedQuantity),
      })),
    };
  }
}
