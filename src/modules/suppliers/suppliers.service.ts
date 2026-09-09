import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationService } from '../notifications/notifications.service';
import { SupplierNotificationTemplates } from '../notifications/templates/supplier.templates';
import { PaymentMethod } from '../../common/constants/payment-method';
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
    await this.findOne(tenantId, id);
    return this.prisma.supplier.update({ where: { id }, data: dto });
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
    const [items, movements, flows] = await Promise.all([
      this.prisma.productItemSupplier.count({ where: { supplierId: id } }),
      this.prisma.stockMovementRequest.count({
        where: { fromSupplierId: id },
      }),
      this.prisma.cashFlow.count({ where: { supplierId: id } }),
    ]);
    if (items + movements + flows > 0) {
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
}
