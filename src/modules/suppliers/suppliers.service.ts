import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationService } from '../notifications/notifications.service';
import { SupplierNotificationTemplates } from '../notifications/templates/supplier.templates';
import { PaymentMethod } from '../../common/constants/payment-method';
import {
  IMPORT_SOURCE_FOR_SUPPLIER_TYPE,
  ImportSource,
  SupplierType,
} from '../../common/constants/inventory-ledger';
import type { NotificationContent } from '../notifications/notification-content.type';
import { crossedCreditWarning } from './credit-warning';
import {
  generateReference,
  REFERENCE_PREFIX,
} from '../../common/utils/reference-generator';
import { paginate, skipFor } from '../../common/utils/pagination';
import { CreateSupplierDto } from './dto/create-supplier.dto';
import { UpdateSupplierDto } from './dto/update-supplier.dto';
import { QuerySupplierDto } from './dto/query-supplier.dto';
import { PaySupplierDebtDto } from './dto/pay-supplier-debt.dto';
import { Prisma } from '../../../generated/prisma/client';
import { ErrorCode } from '../../common/errors/error-codes';

// Ported from iKiotMS-BE's SupplierService + SupplierController.
@Injectable()
export class SupplierService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
  ) {}

  async findAll(tenantId: string, query: QuerySupplierDto) {
    const where: Prisma.SupplierWhereInput = { tenantId };
    if (query.search) {
      where.OR = [
        { supplierName: { contains: query.search, mode: 'insensitive' } },
        { phoneNumber: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    if (query.hasDebt) {
      where.outstandingDebt = { gt: 0 };
    }
    if (query.type) {
      where.type = query.type;
    }

    const [data, total] = await Promise.all([
      this.prisma.supplier.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: skipFor(query.page, query.limit),
        take: query.limit,
      }),
      this.prisma.supplier.count({ where }),
    ]);

    return paginate(data, total, query.page, query.limit);
  }

  async findOne(tenantId: string, id: string) {
    const supplier = await this.prisma.supplier.findFirst({
      where: { id, tenantId },
    });
    if (!supplier)
      throw new NotFoundException({
        code: ErrorCode.SUPPLIER_NOT_FOUND,
        message: 'Supplier not found',
      });
    return supplier;
  }

  create(tenantId: string, dto: CreateSupplierDto) {
    return this.prisma.supplier.create({
      data: {
        tenantId,
        supplierName: dto.supplierName,
        type: dto.type ?? SupplierType.GOODS,
        contactName: dto.contactName,
        phoneNumber: dto.phoneNumber,
        email: dto.email,
        address: dto.address,
        creditLimit: dto.creditLimit ?? 0,
        outstandingDebt: 0, // always starts at zero - only stock movements raise it
      },
    });
  }

  async update(tenantId: string, id: string, dto: UpdateSupplierDto) {
    const supplier = await this.findOne(tenantId, id);
    if (dto.type && dto.type !== supplier.type) {
      await this.assertTypeIsFree(id);
    }
    return this.prisma.supplier.update({ where: { id }, data: dto });
  }

  /** `type` decides which import flow a supplier feeds (`IMPORT_SOURCE_FOR_SUPPLIER_TYPE`), so once an import or a production request names it, switching would leave those documents claiming a flow the supplier no longer belongs to. */
  private async assertTypeIsFree(supplierId: string): Promise<void> {
    const [movements, requests] = await Promise.all([
      this.prisma.stockMovementRequest.count({
        where: { fromSupplierId: supplierId },
      }),
      this.prisma.productionRequest.count({ where: { supplierId } }),
    ]);
    if (movements + requests > 0) {
      throw new ConflictException({
        code: ErrorCode.SUPPLIER_TYPE_LOCKED,
        message:
          'The supplier type cannot change once an import or a production request names it',
      });
    }
  }

  async remove(tenantId: string, id: string) {
    const supplier = await this.findOne(tenantId, id);

    if (supplier.outstandingDebt.greaterThan(0)) {
      throw new BadRequestException({
        code: ErrorCode.SUPPLIER_HAS_DEBT,
        message: 'A supplier with outstanding debt cannot be deleted',
      });
    }

    // Supplier has no status column, so this is a hard delete - the rows pointing at it have to be checked first, or Postgres answers with a foreign key violation Nest can only turn into a 500.
    const [items, movements, flows, requests] = await Promise.all([
      this.prisma.productItemSupplier.count({ where: { supplierId: id } }),
      this.prisma.stockMovementRequest.count({
        where: { fromSupplierId: id },
      }),
      this.prisma.cashFlow.count({ where: { supplierId: id } }),
      this.prisma.productionRequest.count({ where: { supplierId: id } }),
    ]);
    if (items + movements + flows + requests > 0) {
      throw new BadRequestException({
        code: ErrorCode.SUPPLIER_HAS_TRANSACTIONS,
        message:
          'A supplier with goods or transactions cannot be deleted. You can stop using it instead.',
      });
    }

    return this.prisma.supplier.delete({ where: { id } });
  }

  /** Record a payment against a supplier's outstanding debt: lower the debt and write the matching EXPENSE cash flow in one transaction, then notify the owners. The flow is recorded at tenant level, because paying a supplier is not a branch's till. */
  async payDebt(
    tenantId: string,
    actorId: string,
    supplierId: string,
    dto: PaySupplierDebtDto,
  ) {
    const amount = new Prisma.Decimal(dto.amount);

    const result = await this.prisma.$transaction(async (tx) => {
      const supplier = await tx.supplier.findFirst({
        where: { id: supplierId, tenantId },
      });
      if (!supplier)
        throw new NotFoundException({
          code: ErrorCode.SUPPLIER_NOT_FOUND,
          message: 'Supplier not found',
        });

      // Conditional update rather than read-check-write: two payments submitted at once would both pass a plain comparison and overdraw the debt.
      const decremented = await tx.supplier.updateMany({
        where: { id: supplierId, tenantId, outstandingDebt: { gte: amount } },
        data: { outstandingDebt: { decrement: amount } },
      });
      if (decremented.count === 0) {
        throw new BadRequestException({
          code: ErrorCode.SUPPLIER_PAYMENT_EXCEEDS_DEBT,
          message: 'The payment exceeds the outstanding debt',
        });
      }

      const updated = await tx.supplier.findFirstOrThrow({
        where: { id: supplierId },
      });

      const cashFlow = await tx.cashFlow.create({
        data: {
          tenantId,
          flowType: 'EXPENSE',
          amount,
          paymentMethod: dto.paymentMethod ?? PaymentMethod.CASH,
          createdById: actorId,
          supplierId,
          paymentReference: generateReference(REFERENCE_PREFIX.SUPPLIER),
          description:
            dto.note ??
            `Thanh toán công nợ cho nhà cung cấp ${supplier.supplierName}`,
        },
      });

      return { supplier: updated, paymentTransaction: cashFlow };
    });

    // After the commit - notify() never throws, and a failed notification must not undo a recorded payment.
    const owners = (await this.notifications.tenantOwners(tenantId)).filter(
      (id) => id !== actorId,
    );
    if (owners.length > 0) {
      await this.notifications.notify({
        tenantId,
        recipientIds: owners,
        ...SupplierNotificationTemplates.debtPaid(
          result.supplier.supplierName,
          dto.amount,
          result.supplier.outstandingDebt.toNumber(),
        ),
        referenceId: result.paymentTransaction.id,
      });
    }

    return result;
  }

  // ─── Payables: what receiving goods does to a supplier ─────────────────────
  // Shared by the two flows that receive goods against a supplier - supplier imports
  // (`/stock-movements`) and workshop receipts (`/production-requests/:id/receive`) - so the
  // credit rules exist once (coding rule 6). They used to be private to StockMovementService.

  /** The supplier an import draws on, which must belong to the tenant and feed this import flow: a GOODS supplier sells finished goods (SUPPLIER), a WORKSHOP makes them to order (WORKSHOP). A workshop's goods only arrive through a production request, so naming one on a plain import gets its own code. */
  async requireForImport(
    tenantId: string,
    supplierId: string | null | undefined,
    source: ImportSource,
  ) {
    if (!supplierId) {
      throw new BadRequestException({
        code: ErrorCode.STOCK_MOVEMENT_SUPPLIER_REQUIRED,
        message: 'An import must have a supplier',
      });
    }
    const supplier = await this.prisma.supplier.findFirst({
      where: { id: supplierId, tenantId },
    });
    if (!supplier) {
      throw new NotFoundException({
        code: ErrorCode.SUPPLIER_NOT_FOUND,
        message: 'Supplier not found',
      });
    }
    const feeds =
      IMPORT_SOURCE_FOR_SUPPLIER_TYPE[supplier.type as SupplierType];
    if (feeds !== source) {
      if (source === ImportSource.WORKSHOP) {
        throw new BadRequestException({
          code: ErrorCode.SUPPLIER_NOT_WORKSHOP,
          message: 'A production request must be sent to a workshop',
        });
      }
      if (feeds === ImportSource.WORKSHOP) {
        throw new BadRequestException({
          code: ErrorCode.IMPORT_WORKSHOP_VIA_PRODUCTION_REQUEST,
          message:
            "A workshop's goods are received through its production request, not a stock movement",
        });
      }
      throw new BadRequestException({
        code: ErrorCode.IMPORT_SOURCE_SUPPLIER_MISMATCH,
        message: `This supplier cannot feed a ${source} import`,
      });
    }
    return supplier;
  }

  /** Refuses an import that would push the supplier past their credit limit; a limit of 0 or less means no limit, matching how the field is seeded. Advisory - several imports can be open at once, so `charge` re-checks against the debt that actually lands. */
  assertCreditHeadroom(
    supplier: { creditLimit: Prisma.Decimal; outstandingDebt: Prisma.Decimal },
    amount: number,
  ): void {
    const limit = Number(supplier.creditLimit);
    if (limit <= 0) return;

    const projected = Number(supplier.outstandingDebt) + amount;
    if (projected > limit) {
      throw new BadRequestException({
        code: ErrorCode.SUPPLIER_CREDIT_LIMIT_EXCEEDED,
        message: `Credit limit exceeded. Current debt: ${Number(supplier.outstandingDebt)}, this movement: ${amount}, limit: ${limit}`,
      });
    }
  }

  /** Books received goods against the supplier: debt up, and the variants recorded as things this supplier sells us. The limit is re-checked after the increment and throws to roll the receipt back, since several imports can be open at once; returns the warning to send after commit (`notifyCreditWarning`), or null. Runs inside the caller's transaction. */
  async charge(
    tx: Prisma.TransactionClient,
    tenantId: string,
    supplierId: string,
    amount: number,
    receivedItemIds: string[],
  ): Promise<NotificationContent | null> {
    if (receivedItemIds.length > 0) {
      // Idempotent: receiving twice from the same supplier must not fail on the join row.
      await tx.productItemSupplier.createMany({
        data: receivedItemIds.map((productItemId) => ({
          productItemId,
          supplierId,
        })),
        skipDuplicates: true,
      });
    }
    if (amount <= 0) return null;

    const supplier = await tx.supplier.update({
      where: { id: supplierId },
      data: { outstandingDebt: { increment: amount } },
      select: {
        supplierName: true,
        creditLimit: true,
        outstandingDebt: true,
        tenantId: true,
      },
    });
    if (supplier.tenantId !== tenantId) {
      throw new NotFoundException({
        code: ErrorCode.SUPPLIER_NOT_FOUND,
        message: 'Supplier not found',
      });
    }

    const limit = Number(supplier.creditLimit);
    if (limit <= 0) return null;

    const debt = Number(supplier.outstandingDebt);
    if (debt > limit) {
      throw new BadRequestException({
        code: ErrorCode.SUPPLIER_CREDIT_LIMIT_EXCEEDED,
        message: `Credit limit exceeded on receipt. New debt: ${debt}, limit: ${limit}`,
      });
    }

    return crossedCreditWarning(debt, amount, limit)
      ? SupplierNotificationTemplates.creditLimitWarning(
          supplier.supplierName,
          debt,
          limit,
        )
      : null;
  }

  /** After the commit: the warning `charge` returned goes to the owners, not to the person receiving the goods. Never throws (`notify()` doesn't). */
  async notifyCreditWarning(
    tenantId: string,
    actorId: string,
    supplierId: string,
    warning: NotificationContent | null,
  ): Promise<void> {
    if (!warning) return;
    const owners = await this.notifications.tenantOwners(tenantId);
    await this.notifications.notify({
      tenantId,
      recipientIds: owners.filter((ownerId) => ownerId !== actorId),
      referenceId: supplierId,
      ...warning,
    });
  }
}
