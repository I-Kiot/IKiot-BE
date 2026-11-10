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
import {
  BRANCH_NAME_SELECT,
  namedBranch,
} from '../../common/dto/location-ref.dto';

const CODE_PREFIX = 'KH';

/** Chỉ giữ chữ số, nên `090 123 4567` và `0901234567` là cùng một khách; rỗng thì thành `undefined`. */
function normalizePhone(phone?: string | null): string | undefined {
  const digits = phone?.replace(/\D/g, '') ?? '';
  return digits.length > 0 ? digits : undefined;
}

/** Port thật từ CustomerService. Xoá là xoá mềm (`isDeleted`) vì đơn hàng và log khuyến mãi trỏ tới dòng này, mỗi giao dịch phải truy ngược được; mọi lần đọc đều lọc bỏ. */
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
        email: dto.email,
        gender: dto.gender,
        address: dto.address,
        dob: dto.dob ? new Date(dto.dob) : undefined,
      },
    });
  }

  /** Khách cho form đơn nhập tay. Một số điện thoại là một khách đang hoạt động: số đã có trả về khách đó, không ghi đè tên và địa chỉ (đơn mang thông tin người nhận riêng); chưa có thì tạo mới như `POST /customers`. */
  async findOrCreateForOrder(
    tenantId: string,
    input: { name: string; phone?: string; address?: string },
  ): Promise<string> {
    const phone = normalizePhone(input.phone);
    if (phone) {
      const existing = await this.prisma.customer.findFirst({
        where: { tenantId, phone, isDeleted: false },
        select: { id: true },
      });
      if (existing) return existing.id;
    }
    const created = await this.create(tenantId, {
      name: input.name,
      phone,
      address: input.address,
    });
    return created.id;
  }

  /** Danh sách khách, mỗi dòng kèm lịch sử đơn qua relation (không gom trên bộ nhớ như bản cũ), chỉ lấy 10 đơn gần nhất để khách mua nhiều không làm chậm trang. */
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
              branch: BRANCH_NAME_SELECT,
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
        branch: namedBranch(order.branch),
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
    // `undefined` thì giữ nguyên số; trường bị xoá trống thì xoá số.
    const phone =
      dto.phone === undefined ? undefined : (normalizePhone(dto.phone) ?? null);
    if (phone) await this.assertPhoneIsFree(tenantId, phone, id);

    return this.prisma.customer.update({
      where: { id },
      data: {
        name: dto.name,
        customerCode: dto.customerCode,
        phone,
        email: dto.email,
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

  /** Xoá mềm hàng loạt, lọc theo tenant ngay trong câu lệnh: id của tenant khác sẽ không khớp, và số trả về là số khách thuộc tenant này. */
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

  /** Một số điện thoại, một khách: POS tra khách theo SĐT nên hai dòng trùng số sẽ làm tra cứu mơ hồ. Dòng đã xoá mềm không tính. */
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

  /** `KH000001`, `KH000002`, ... - số kế tiếp sau mã lớn nhất đã sinh trong tenant. Mã nhập tay có dạng khác bị bỏ qua; nếu trùng (hoặc có insert đồng thời) thì unique index chặn và thử số tiếp theo. */
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

  /** Mã khách là thứ nhân viên gõ để tìm khách, nên `@@unique([tenantId, customerCode])` ép tính duy nhất (cột nullable nên khách nào cũng có thể không có mã); check này chạy trước chỉ để báo đúng mã bị trùng. */
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
