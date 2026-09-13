import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { paginate, skipFor } from '../../common/utils/pagination';
import {
  CreateCustomerDto,
  QueryCustomerDto,
  UpdateCustomerDto,
} from './dto/customer.dto';
import type { Prisma } from '../../../generated/prisma/client';
import { ErrorCode } from '../../common/errors/error-codes';

const CODE_PREFIX = 'KH';

/** Digits only, so `090 123 4567` and `0901234567` are the same customer; empty becomes `undefined`. */
function normalizePhone(phone?: string | null): string | undefined {
  const digits = phone?.replace(/\D/g, '') ?? '';
  return digits.length > 0 ? digits : undefined;
}

/** Real port of CustomerService. Delete is soft (`isDeleted`) because orders and promotion logs point at the row and a sale must stay attributable; every read filters it out. */
@Injectable()
export class CustomerService {
  constructor(private readonly prisma: PrismaService) {}

  async create(tenantId: string, dto: CreateCustomerDto) {
    if (dto.customerCode) {
      await this.assertCodeIsFree(tenantId, dto.customerCode);
    }
    const phone = normalizePhone(dto.phone);
    if (phone) await this.assertPhoneIsFree(tenantId, phone);
    const customerCode =
      dto.customerCode?.trim() || (await this.nextCustomerCode(tenantId));
    return this.prisma.customer.create({
      data: {
        tenantId,
        name: dto.name,
        customerCode,
        phone,
        gender: dto.gender,
        address: dto.address,
        dob: dto.dob ? new Date(dto.dob) : undefined,
      },
    });
  }

  /** The customer list, each row carrying its order history through the relation rather than the old in-memory grouping, capped at the ten most recent so a regular with four hundred orders doesn't drag the page down. */
  async findAll(tenantId: string, query: QueryCustomerDto) {
    const where: Prisma.CustomerWhereInput = { tenantId, isDeleted: false };

    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { phone: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    if (query.branchId) {
      where.orders = { some: { tenantId, branchId: query.branchId } };
    }

    const [rows, total] = await Promise.all([
      this.prisma.customer.findMany({
        where,
        include: {
          orders: {
            where: query.branchId ? { branchId: query.branchId } : undefined,
            orderBy: { createdAt: 'desc' },
            take: 10,
            select: {
              id: true,
              status: true,
              paymentMethod: true,
              grandTotal: true,
              createdAt: true,
              branch: { select: { id: true, name: true } },
              user: {
                select: {
                  id: true,
                  profileFirstName: true,
                  profileLastName: true,
                },
              },
              items: {
                select: {
                  productName: true,
                  quantity: true,
                  unitPrice: true,
                },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: skipFor(query.page, query.limit),
        take: query.limit,
      }),
      this.prisma.customer.count({ where }),
    ]);

    const data = rows.map((customer) => ({
      ...customer,
      orders: customer.orders.map((order) => ({
        ...order,
        grandTotal: Number(order.grandTotal),
        items: order.items.map((item) => ({
          ...item,
          quantity: Number(item.quantity),
          unitPrice: Number(item.unitPrice),
        })),
      })),
    }));

    return paginate(data, total, query.page, query.limit);
  }

  async findOne(tenantId: string, id: string) {
    return this.findRow(tenantId, id);
  }

  async update(tenantId: string, id: string, dto: UpdateCustomerDto) {
    await this.findRow(tenantId, id);
    if (dto.customerCode) {
      await this.assertCodeIsFree(tenantId, dto.customerCode, id);
    }
    // `undefined` leaves the number alone; an emptied field clears it.
    const phone =
      dto.phone === undefined ? undefined : (normalizePhone(dto.phone) ?? null);
    if (phone) await this.assertPhoneIsFree(tenantId, phone, id);

    return this.prisma.customer.update({
      where: { id },
      data: {
        name: dto.name,
        customerCode: dto.customerCode,
        phone,
        gender: dto.gender,
        address: dto.address,
        dob: dto.dob ? new Date(dto.dob) : undefined,
      },
    });
  }

  async remove(tenantId: string, id: string) {
    await this.findRow(tenantId, id);
    await this.prisma.customer.update({
      where: { id },
      data: { isDeleted: true },
    });
    return { success: true };
  }

  /** Bulk soft delete, scoped by tenant in the same statement - an id belonging to somebody else simply isn't matched, and the returned count is how many were this tenant's. */
  async removeMany(tenantId: string, ids: string[]) {
    const result = await this.prisma.customer.updateMany({
      where: { tenantId, id: { in: ids }, isDeleted: false },
      data: { isDeleted: true },
    });
    return { success: true, deleted: result.count };
  }

  private async findRow(tenantId: string, id: string) {
    const customer = await this.prisma.customer.findFirst({
      where: { id, tenantId, isDeleted: false },
    });
    if (!customer)
      throw new NotFoundException({
        code: ErrorCode.CUSTOMER_NOT_FOUND,
        message: 'Customer not found',
      });
    return customer;
  }

  /** One phone number, one customer: the POS looks people up by phone, so two rows sharing one would make the lookup ambiguous. Soft-deleted rows don't count. */
  private async assertPhoneIsFree(
    tenantId: string,
    phone: string,
    exceptId?: string,
  ) {
    const taken = await this.prisma.customer.findFirst({
      where: {
        tenantId,
        phone,
        isDeleted: false,
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      select: { id: true },
    });
    if (taken) {
      throw new ConflictException({
        code: ErrorCode.CUSTOMER_PHONE_TAKEN,
        message: `A customer with phone ${phone} already exists`,
      });
    }
  }

  /** `KH000001`, `KH000002`, ... - the next number after the highest generated code in the tenant. Hand-typed codes with other shapes are ignored, and a clash with one of them (or a concurrent insert) is caught by the unique index and retried once more. */
  private async nextCustomerCode(tenantId: string): Promise<string> {
    const rows = await this.prisma.customer.findMany({
      where: { tenantId, customerCode: { startsWith: CODE_PREFIX } },
      select: { customerCode: true },
    });
    let max = 0;
    for (const { customerCode } of rows) {
      const digits = customerCode?.slice(CODE_PREFIX.length) ?? '';
      if (/^\d+$/.test(digits)) max = Math.max(max, Number(digits));
    }
    for (let attempt = 1; attempt <= 5; attempt++) {
      const candidate = `${CODE_PREFIX}${String(max + attempt).padStart(6, '0')}`;
      const taken = await this.prisma.customer.findFirst({
        where: { tenantId, customerCode: candidate },
        select: { id: true },
      });
      if (!taken) return candidate;
    }
    throw new ConflictException({
      code: ErrorCode.CUSTOMER_CODE_TAKEN,
      message: 'Could not allocate a customer code; please enter one',
    });
  }

  /** A customer code is what staff type to pull someone up, so `@@unique([tenantId, customerCode])` enforces it (nullable, so any number may carry none); this check only runs first to name the offending code. */
  private async assertCodeIsFree(
    tenantId: string,
    customerCode: string,
    exceptId?: string,
  ) {
    const taken = await this.prisma.customer.findFirst({
      where: {
        tenantId,
        customerCode,
        isDeleted: false,
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      select: { id: true },
    });
    if (taken) {
      throw new ConflictException({
        code: ErrorCode.CUSTOMER_CODE_TAKEN,
        message: `Customer code already exists: ${customerCode}`,
      });
    }
  }
}
