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

// Port từ SupplierService + SupplierController của iKiotMS-BE (bản cũ).
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
        outstandingDebt: 0, // Luôn bắt đầu bằng 0; chỉ nhận hàng mới làm nợ tăng.
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

  /** `type` quyết định NCC thuộc luồng nhập nào (`IMPORT_SOURCE_FOR_SUPPLIER_TYPE`). Đã có phiếu nhập hoặc yêu cầu sản xuất gắn vào thì không đổi được, nếu không các phiếu đó sẽ thuộc luồng mà NCC không còn thuộc. */
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

    // Supplier không có cột status nên xoá cứng: phải kiểm các dòng đang trỏ tới trước, nếu không Postgres báo lỗi khoá ngoại và Nest chỉ trả được 500.
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

  /** Ghi một khoản trả nợ NCC: giảm nợ và ghi phiếu chi (EXPENSE) trong một transaction, rồi báo chủ shop. Ghi ở cấp tenant vì trả NCC không phải quỹ của chi nhánh nào. */
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

      // Dùng UPDATE có điều kiện thay vì đọc-kiểm-ghi: hai khoản trả gửi cùng lúc sẽ cùng qua so sánh thường và làm nợ âm.
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

    // Sau commit: notify() không ném lỗi, và thông báo lỗi không được làm mất khoản trả đã ghi.
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

  // Ghi nhận công nợ khi nhận hàng từ NCC, dùng chung cho nhập NCC (`/stock-movements`) và nhận từ thợ
  // (`/production-requests/:id/receive`), để quy tắc hạn mức chỉ có một nơi (coding rule 6).

  /** NCC của phiếu nhập: phải thuộc tenant và đúng luồng. GOODS bán hàng có sẵn (SUPPLIER), WORKSHOP làm theo đơn (WORKSHOP). Hàng thợ chỉ về qua yêu cầu sản xuất, nên gọi trong nhập thường có mã lỗi riêng. */
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

  /** Từ chối phiếu nhập làm NCC vượt hạn mức; hạn mức `0` trở xuống nghĩa là không giới hạn (khớp cách seed). Chỉ kiểm sơ bộ: nhiều phiếu có thể mở cùng lúc, nên `charge` kiểm lại theo nợ thực tế. */
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

  /** Ghi nhận hàng nhận về: nợ tăng, và các biến thể được ghi là NCC này bán cho mình. Hạn mức kiểm lại sau khi tăng và throw để rollback phiếu nhận (vì nhiều phiếu có thể mở cùng lúc); trả cảnh báo để gửi sau commit (`notifyCreditWarning`) hoặc null. Chạy trong transaction của người gọi. */
  async charge(
    tx: Prisma.TransactionClient,
    tenantId: string,
    supplierId: string,
    amount: number,
    receivedItemIds: string[],
  ): Promise<NotificationContent | null> {
    if (receivedItemIds.length > 0) {
      // Idempotent: nhận hai lần từ cùng NCC không được lỗi ở dòng nối.
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

  /** Sau commit: cảnh báo `charge` trả về gửi cho chủ shop, không gửi cho người nhận hàng. Không bao giờ ném lỗi (`notify()` cũng vậy). */
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
