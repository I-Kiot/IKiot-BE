import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { FulfillmentType } from '../../common/constants/order-status';
import { ErrorCode } from '../../common/errors/error-codes';
import {
  BRANCH_NAME_SELECT,
  namedBranch,
} from '../../common/dto/location-ref.dto';
import { paginate, skipFor } from '../../common/utils/pagination';
import { narrowToScope } from '../../common/utils/scope-filter';
import { can } from '../../common/utils/permission';
import type { AuthUser } from '../../common/types/auth-user.type';
import { toUserRef } from '../orders/order-read.mapper';
import { USER_REF_SELECT } from '../orders/order-read';
import type { QueryInvoiceDto } from './dto/query-invoice.dto';

const INVOICE_INCLUDE = {
  lines: { orderBy: { position: 'asc' } },
  order: {
    select: {
      id: true,
      code: true,
      status: true,
      fulfillmentType: true,
      paymentMethod: true,
      paymentStatus: true,
      branchId: true,
      customerPay: true,
      change: true,
      note: true,
      branch: BRANCH_NAME_SELECT,
      user: USER_REF_SELECT,
      customer: {
        select: {
          id: true,
          customerCode: true,
          name: true,
          phone: true,
          gender: true,
          address: true,
        },
      },
    },
  },
} as const satisfies Prisma.InvoiceInclude;

type InvoiceRow = Prisma.InvoiceGetPayload<{ include: typeof INVOICE_INCLUDE }>;

/**
 * `GET /invoices`, `GET /invoices/:id`. Read-only: an invoice is written only by the order routes that
 * complete, return or cancel an order (`InvoiceService`), never by a request of its own.
 * Visibility is the order's: own branch, or every branch with `orders:view_all`.
 */
@Injectable()
export class InvoiceReadService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(user: AuthUser, tenantId: string, query: QueryInvoiceDto) {
    const scope = this.branchScope(user);
    const branchId = narrowToScope(
      scope.branchId,
      query.branchId,
      'You can only view invoices for your own branch',
    );

    const and: Prisma.InvoiceWhereInput[] = [
      { tenantId, ...(branchId ? { order: { branchId } } : {}) },
    ];
    if (query.status) and.push({ status: query.status });
    if (query.type) and.push({ type: query.type });
    if (query.fulfillmentType) {
      and.push({ order: { fulfillmentType: query.fulfillmentType } });
    }
    if (query.kind) {
      and.push({
        order: {
          fulfillmentType:
            query.kind === 'COUNTER'
              ? FulfillmentType.TAKEAWAY
              : { not: FulfillmentType.TAKEAWAY },
        },
      });
    }
    if (query.search) {
      const contains = { contains: query.search, mode: 'insensitive' } as const;
      and.push({
        OR: [
          { invoiceNumber: contains },
          { order: { code: contains } },
          { order: { customer: { name: contains } } },
          { order: { customer: { phone: contains } } },
        ],
      });
    }
    if (query.fromDate || query.toDate) {
      and.push({
        createdAt: {
          ...(query.fromDate ? { gte: new Date(query.fromDate) } : {}),
          ...(query.toDate ? { lte: new Date(query.toDate) } : {}),
        },
      });
    }
    const where: Prisma.InvoiceWhereInput = { AND: and };

    const [rows, total] = await Promise.all([
      this.prisma.invoice.findMany({
        where,
        include: INVOICE_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: skipFor(query.page, query.limit),
        take: query.limit,
      }),
      this.prisma.invoice.count({ where }),
    ]);
    return paginate(
      rows.map(toInvoiceResponse),
      total,
      query.page,
      query.limit,
    );
  }

  async findOne(user: AuthUser, tenantId: string, id: string) {
    const scope = this.branchScope(user);
    const row = await this.prisma.invoice.findFirst({
      where: {
        id,
        tenantId,
        ...(scope.branchId ? { order: { branchId: scope.branchId } } : {}),
      },
      include: INVOICE_INCLUDE,
    });
    if (!row) {
      throw new NotFoundException({
        code: ErrorCode.INVOICE_NOT_FOUND,
        message: 'Invoice not found',
      });
    }
    return toInvoiceResponse(row);
  }

  private branchScope(user: AuthUser): { branchId?: string } {
    if (can(user, 'orders', 'view_all')) return {};
    if (!user.branchId) {
      throw new ForbiddenException({
        code: ErrorCode.ACCOUNT_HAS_NO_BRANCH,
        message: 'This account has not been assigned to a branch',
      });
    }
    return { branchId: user.branchId };
  }
}

const num = (value: Prisma.Decimal | number | null) =>
  value === null ? null : Number(value);

function toInvoiceResponse(row: InvoiceRow) {
  const { order, lines, ...invoice } = row;
  return {
    ...invoice,
    subtotal: num(invoice.subtotal),
    vatAmount: num(invoice.vatAmount),
    total: num(invoice.total),
    kind:
      order.fulfillmentType === FulfillmentType.TAKEAWAY
        ? 'COUNTER'
        : 'ORDERED',
    order: {
      id: order.id,
      code: order.code,
      status: order.status,
      fulfillmentType: order.fulfillmentType,
      paymentMethod: order.paymentMethod,
      paymentStatus: order.paymentStatus,
      customerPay: num(order.customerPay),
      change: num(order.change),
      note: order.note,
    },
    branch: namedBranch(order.branch),
    customer: order.customer,
    seller: toUserRef(order.user),
    lines: lines.map((line) => ({
      ...line,
      unitPrice: num(line.unitPrice),
      vatRate: num(line.vatRate),
      amount: num(line.amount),
    })),
  };
}
