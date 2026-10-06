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
import { withNestedProfile } from '../../common/utils/user-profile';

const DETAIL_INCLUDE = {
  details: {
    select: {
      id: true,
      productItemId: true,
      quantity: true,
      importPrice: true,
      receivedQuantity: true,
      note: true,
      productItem: {
        select: { id: true, sku: true, productName: true, productCode: true },
      },
    },
  },
  fromSupplier: { select: { id: true, supplierName: true } },
  fromLocation: LOCATION_SELECT,
  toLocation: LOCATION_SELECT,
  createdBy: {
    select: {
      id: true,
      phoneNumber: true,
      email: true,
      profileFirstName: true,
      profileLastName: true,
    },
  },
} as const satisfies Prisma.StockMovementRequestInclude;

type MovementRow = Prisma.StockMovementRequestGetPayload<{
  include: typeof DETAIL_INCLUDE;
}>;

/** Real port of StockMovementService. Two rules run through all of it: stock changes and the status change share one transaction, and notifications plus low-stock warnings are sent after it commits and never throw. Access is a substitution for the old manager roles - an owner acts anywhere, a STAFF account where it is posted, plus `managedScheduleAccess` while supervising a shift, which enters through `canActAt()` alone. The old "branch managers cannot create IMPORTs / EXPORT to a warehouse" rules are dropped: the first is now who holds `stock_movement:create`, the second survives in `assertTransferMakesSense`. */
@Injectable()
export class StockMovementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly notifications: NotificationService,
    private readonly suppliers: SupplierService,
  ) {}

  // ─── Reads ─────────────────────────────────────────────────────────────────

  async findAll(user: AuthUser, query: QueryStockMovementDto) {
    const tenantId = this.tenantOf(user);
    const where: Prisma.StockMovementRequestWhereInput = { tenantId };
    if (query.status) where.status = query.status;
    if (query.movementType) where.movementType = query.movementType;

    // A staff account sees the movements that touch their own location, from either end.
    const own = this.postingOf(user);
    if (own) {
      if (!own.locationId) {
        // Posted nowhere: there is no location whose movements they could be looking at, and matching the column directly would quietly match rows where it is null.
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
    // Viewable from either end - the sender and the receiver both need to see it.
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

  // ─── Create ────────────────────────────────────────────────────────────────

  async create(user: AuthUser, dto: CreateStockMovementDto) {
    const tenantId = this.tenantOf(user);
    this.assertNoDuplicateItems(dto.details);

    // Both ends in one query: existence, tenant and kind (the kind drives the RETURN rule).
    // This runs before the access checks, so a location in another tenant answers 404
    // rather than 403 - coding rule 5.
    const fromId = this.resolveSourceId(user, dto);
    const ends = await resolveLocations(this.prisma, tenantId, [
      fromId,
      dto.toLocationId,
    ]);
    const from = fromId ? ends.get(fromId)! : null;
    const to = dto.toLocationId ? ends.get(dto.toLocationId)! : null;
    // An IMPORT has no source, so it is scoped by its destination - left unchecked, a staff account could file goods in against any warehouse.
    if (dto.movementType === MovementType.IMPORT) {
      if (to) this.assertCanActAt(user, to);
    } else if (this.isTransferType(dto.movementType)) {
      // Either end may raise a transfer: the sender pushing goods out, or the receiver
      // asking for them. Only one endpoint has to be the actor's - the other is whoever
      // they are trading with. Every later step still checks the end that acts.
      if (!this.canActAt(user, from) && !this.canActAt(user, to)) {
        throw new ForbiddenException({
          code: ErrorCode.STOCK_MOVEMENT_LOCATION_DENIED,
          message:
            'A transfer must be raised from either its source or its destination',
        });
      }
    } else if (from) {
      // ADJUST counts stock at one location, so it is only ever filed there.
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
      // A workshop's goods come in only through its production request (contract §3).
      const supplier = await this.suppliers.requireForImport(
        tenantId,
        dto.fromSupplierId,
        ImportSource.SUPPLIER,
      );
      this.suppliers.assertCreditHeadroom(supplier, totalPrice);
    }

    // IMPORT and ADJUST have nothing to pick and pack, so they open at PENDING.
    const status =
      dto.movementType === MovementType.IMPORT ||
      dto.movementType === MovementType.ADJUST
        ? MovementStatus.PENDING
        : MovementStatus.DRAFT;

    const created = await this.prisma.stockMovementRequest.create({
      data: {
        tenantId,
        movementType: dto.movementType,
        // The stock_movement_requests_import_source_iff_import CHECK needs a source on every IMPORT and none elsewhere. Only the supplier flow exists today; B-5 adds WORKSHOP and lets the client choose.
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

    // A transfer raised by the end that wants the goods is a request, not paperwork about
    // a shipment already agreed - so the source hears a different sentence. Who is told
    // does not change: the source is the side that has to pick and pack either way.
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
      // An import is awaited by the place receiving it; a transfer is actioned by the place sending it.
      notifyFrom: created.movementType !== MovementType.IMPORT,
      notifyTo: created.movementType === MovementType.IMPORT,
    });

    return this.toResponse(created);
  }

  // ─── State transitions ─────────────────────────────────────────────────────

  /** Replace the lines. Allowed while the request is still being written up. */
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
      // Either end may still correct the list while it is open.
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
      await tx.stockMovementRequestItem.deleteMany({
        where: { requestId: id },
      });
      return tx.stockMovementRequest.update({
        where: { id },
        data: { totalPrice, details: { create: details } },
        include: DETAIL_INCLUDE,
      });
    });

    return this.toResponse(updated);
  }

  /** DRAFT → OPENING: the sending location starts picking. */
  async open(user: AuthUser, id: string) {
    const request = await this.findRow(this.tenantOf(user), id);
    this.assertCanActAt(user, this.source(request));
    this.assertStatus(request, [MovementStatus.DRAFT]);
    await this.assertSourceStock(this.prisma, request);

    return this.toResponse(await this.setStatus(id, MovementStatus.OPENING));
  }

  /** OPENING → CLOSED: picking is finished and the list is final. */
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

    return this.toResponse(await this.setStatus(id, MovementStatus.CLOSED));
  }

  /** → IN_TRANSIT: the goods physically leave, so the source decrement and the status change share one transaction. */
  async ship(user: AuthUser, id: string) {
    const tenantId = this.tenantOf(user);
    const request = await this.findRow(tenantId, id);
    this.assertCanActAt(user, this.source(request));
    this.assertStatus(request, [MovementStatus.CLOSED, MovementStatus.PENDING]);

    const isTransfer = this.isTransferType(request.movementType);

    const { shipped, crossings } = await this.prisma.$transaction(
      async (tx) => {
        const lowStock: (Inventory | null)[] = [];

        if (isTransfer) {
          const from = this.source(request)!;
          for (const line of request.details) {
            const quantity = Number(line.quantity);
            // `deductStock` is the check as well as the write: the `assertSourceStock` calls elsewhere are advisory, and this is what stops two shipments emptying the same shelf twice.
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
          shipped: await tx.stockMovementRequest.update({
            where: { id },
            data: { status: MovementStatus.IN_TRANSIT },
            include: DETAIL_INCLUDE,
          }),
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

  /** → RECEIVED: the destination confirms what turned up, line by line. Received quantities move stock, not ordered ones, so a short delivery is simply never added - and for an IMPORT this is where the supplier's debt goes up, so the credit limit is re-checked here too. */
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

    // Nobody can receive more than was sent: the figure feeds both the stock write and the supplier charge, so an IMPORT of one unit received as a million would conjure inventory and a matching debt. Short deliveries stay allowed; over-delivery needs its own paperwork.
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
            importCost += quantity * Number(line.importPrice ?? 0);
            // Every received import line is its own lot, costed at the import price.
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
            // A transfer: the goods arrive as child lots of the ones that left the source, keeping their origin and cost. One shipped before lots existed has nothing to follow.
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
              )
            : null;

        return {
          received: await tx.stockMovementRequest.update({
            where: { id },
            data: { status: MovementStatus.RECEIVED },
            include: DETAIL_INCLUDE,
          }),
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

  /** ADJUST PENDING → COMPLETED: apply the counted numbers, delta `counted - recorded`. An adjustment that would take a line below zero is refused rather than clamped - a count implying negative stock is wrong, or something moved while it was open. */
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

          // A surplus is a new lot at today's cost price; a shortage draws the lots FIFO and cannot eat into stock held for orders.
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
          completed: await tx.stockMovementRequest.update({
            where: { id },
            data: { status: MovementStatus.COMPLETED },
            include: DETAIL_INCLUDE,
          }),
          crossings: lowStock,
        };
      },
    );

    await this.inventory.notifyLowStock(crossings);
    return this.toResponse(completed);
  }

  /** Cancel, returning stock that had already left: a transfer cancelled IN_TRANSIT is put back, while anything RECEIVED or COMPLETED can only be corrected with a new movement. */
  async cancel(user: AuthUser, id: string) {
    const tenantId = this.tenantOf(user);
    const request = await this.findRow(tenantId, id);

    // Either end may call it off.
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
      if (shouldReturnStock) {
        const from = this.source(request)!;
        // Straight back into the lots it left.
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

      return tx.stockMovementRequest.update({
        where: { id },
        data: { status: MovementStatus.CANCELLED },
        include: DETAIL_INCLUDE,
      });
    });

    await this.notifyMovement(cancelled, user.userId, {
      ...StockMovementNotificationTemplates.cancelled(cancelled.id),
      notifyCreator: true,
      notifyFrom: true,
      notifyTo: true,
    });

    return this.toResponse(cancelled);
  }

  // ─── Line preparation ──────────────────────────────────────────────────────

  /** IMPORT lines need both a price and a quantity, and the import price may not exceed the variant's retail price - buying above what you sell at is a data-entry error that silently poisons every margin report. */
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

  /** EXPORT/RETURN lines: price defaults to cost, and the source must hold the stock. */
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

  /** ADJUST lines: `receivedQuantity` is the counted figure and is required, while `quantity` is what the system thinks and is filled from inventory when absent, so the difference is against the number at count time. */
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
      select: { id: true, sku: true, retailPrice: true, costPrice: true },
    });
    if (items.length !== ids.length) {
      throw new NotFoundException({
        code: ErrorCode.PRODUCT_ITEM_NOT_FOUND,
        message: 'Product item not found',
      });
    }
    return new Map(items.map((item) => [item.id, item]));
  }

  // ─── Guards ────────────────────────────────────────────────────────────────

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

  /** Which fields a movement type needs, in one place - every branch of the state machine downstream assumes these hold. That both ends exist in the tenant was settled by `resolveLocations` before this runs. */
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
        // A stocktake happens at one place; a destination would be meaningless.
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

  /** Builds the lines for whichever movement type this is; `from` is only ever null for an IMPORT, the one type whose lines don't depend on a source location. */
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

  /** A transfer must actually go somewhere else, and one in a return direction must be filed as a RETURN, not an EXPORT - the old rule was phrased as a role restriction, but the direction is what makes it a return. Which directions count lives in `isReturnDirection` (plan 2026-09-29, QĐ-1). */
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

  /** The source must hold every quantity on the request as it stands. */
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
      this.source(request)!, // every EXPORT/RETURN has a source - assertEndpointsValid required it
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
    // Only the shelf can be sent - goods packed for an order are not free to transfer. Advisory: deductStock's guard is what enforces it.
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

  // ─── Access ────────────────────────────────────────────────────────────────

  private tenantOf(user: AuthUser): string {
    if (!user.tenantId) {
      throw new ForbiddenException({
        code: ErrorCode.ACCOUNT_HAS_NO_TENANT,
        message: 'This account does not belong to any shop',
      });
    }
    return user.tenantId;
  }

  /** Where a staff account is posted, or `null` for one that may act anywhere - see `postingOf` in location-access. */
  private postingOf(user: AuthUser): { locationId: string | null } | null {
    return postingOf(user);
  }

  /** The shared location rule (`canActAt` in location-access), so this flow and production requests cannot disagree about who may act where. */
  private canActAt(user: AuthUser, location: LocationEnd | null): boolean {
    return canActAt(user, location);
  }

  /** A movement between two of our own locations - the only kind with a source *and* a destination that both belong to us, and so the only kind either end may raise. */
  private isTransferType(movementType: string): boolean {
    return (
      movementType === MovementType.EXPORT ||
      movementType === MovementType.RETURN
    );
  }

  /** Whether this is literally where the actor works - see `isPostedAt` in location-access. */
  private isPostedAt(user: AuthUser, location: LocationEnd | null): boolean {
    return isPostedAt(user, location);
  }

  /** Takes a missing end too: a staff account can never act at "no location", so it is refused like any other place that isn't theirs. */
  private assertCanActAt(user: AuthUser, location: LocationEnd | null): void {
    if (!this.canActAt(user, location)) {
      throw new ForbiddenException({
        code: ErrorCode.STOCK_MOVEMENT_LOCATION_DENIED,
        message: 'You can only work on stock movements at your own location',
      });
    }
  }

  /** Where the movement takes stock from: a staff account that omitted it gets their own posting, and a TENANT_OWNER has to name one. Access is not checked here - a transfer may be raised from either end, so `create()` decides which endpoint has to match. */
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

  /** The movement's source, or null for an IMPORT (its goods come from a supplier). Callers that act only on transfers or stocktakes assert it with `!`: `assertEndpointsValid` refused those without one at create. */
  private source(request: MovementRow): LocationEnd | null {
    return request.fromLocation;
  }

  /** The movement's destination, or null for an ADJUST (a stocktake happens in one place). */
  private destination(request: MovementRow): LocationEnd | null {
    return request.toLocation;
  }

  // ─── Plumbing ──────────────────────────────────────────────────────────────

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

  private setStatus(id: string, status: string) {
    return this.prisma.stockMovementRequest.update({
      where: { id },
      data: { status },
      include: DETAIL_INCLUDE,
    });
  }

  private totalOf(lines: { quantity: number; importPrice?: number }[]): number {
    return lines.reduce(
      (sum, line) => sum + line.quantity * (line.importPrice ?? 0),
      0,
    );
  }

  /** Tells the people who need to know, after the work is done. The actor is always removed - nobody needs telling about the thing they just did - and `notify()` de-duplicates, so someone who is both creator and receiving manager gets one message. */
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

  /** Decimals become numbers; each end of the movement is the shared `{ id, type, name }` (LOCATION_SELECT) or null, and the raw FK columns are dropped so each place is named once. */
  private toResponse(request: MovementRow) {
    const {
      fromLocationId,
      toLocationId,
      totalPrice,
      details,
      createdBy,
      ...rest
    } = request;

    return {
      ...rest,
      // Nested like every other user payload, so the screens read `createdBy.profile.firstName`.
      createdBy: createdBy ? withNestedProfile(createdBy) : createdBy,
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
