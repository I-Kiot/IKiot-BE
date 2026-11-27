import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { ErrorCode } from '../../../common/errors/error-codes';
import { OrderLineType } from '../../../common/constants/order-status';
import { PaymentKind } from '../../../common/constants/payment-method';
import { WALK_IN_CUSTOMER_CODE } from '../../../common/constants/walk-in-customer';
import type { AuthUser } from '../../../common/types/auth-user.type';
import { OrderReadService } from '../order-read.service';
import {
  DEPOSIT_METHOD_LABELS,
  FULFILLMENT_LABELS,
  ORDER_IMPORT_COLUMNS,
  PRIORITY_LABELS,
} from '../import/order-import.columns';
import {
  OrderImportService,
  staffLabel,
  type OrderSheetRow,
} from '../import/order-import.service';
import type { ExportOrdersDto } from '../dto/export-orders.dto';

/** Giới hạn một file xuất. */
export const MAX_ORDER_EXPORT_ORDERS = 5000;
export const MAX_ORDER_EXPORT_ROWS = 20000;

const STAFF_SELECT = {
  phoneNumber: true,
  profileFirstName: true,
  profileLastName: true,
} as const;

/** Xuất đơn ra Excel theo đúng khuôn file mẫu nhập: mỗi dòng hàng một dòng, "Mã nhóm đơn" là mã đơn. */
@Injectable()
export class OrderExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reads: OrderReadService,
    private readonly importer: OrderImportService,
  ) {}

  async export(
    user: AuthUser,
    tenantId: string,
    query: ExportOrdersDto,
  ): Promise<Buffer> {
    const rows = await this.sheetRows(user, tenantId, query);
    return this.importer.buildFile(user, tenantId, rows);
  }

  /** Cùng dữ liệu với file xuất, mỗi dòng là mảng ô theo đúng thứ tự cột file mẫu (cho nút "Sao chép"). */
  async cells(
    user: AuthUser,
    tenantId: string,
    query: ExportOrdersDto,
  ): Promise<(string | number | null)[][]> {
    const rows = await this.sheetRows(user, tenantId, query);
    return rows.map((row) =>
      ORDER_IMPORT_COLUMNS.map((column) => {
        const value = row[column.key];
        if (value === undefined || value === null || value === '') return null;
        return typeof value === 'number' ? value : String(value);
      }),
    );
  }

  private async sheetRows(
    user: AuthUser,
    tenantId: string,
    query: ExportOrdersDto,
  ): Promise<OrderSheetRow[]> {
    // File nhập không có đơn bán tại quầy.
    const filter = Object.assign(query, { excludePos: true });
    const ids = await this.reads.matchingIds(user, tenantId, filter, query.ids);
    if (ids.length > MAX_ORDER_EXPORT_ORDERS) {
      throw tooLarge(
        `${ids.length} orders, the limit is ${MAX_ORDER_EXPORT_ORDERS}`,
      );
    }

    const orders = await this.prisma.order.findMany({
      where: { tenantId, id: { in: ids } },
      select: {
        id: true,
        code: true,
        fulfillmentType: true,
        priority: true,
        recipientName: true,
        recipientPhone: true,
        deliveryAddress: true,
        requestedDeliveryDate: true,
        shippingFee: true,
        discountValue: true,
        depositAmount: true,
        note: true,
        branch: { select: { location: { select: { name: true } } } },
        customer: {
          select: { customerCode: true, name: true, phone: true },
        },
        assignee: { select: STAFF_SELECT },
        seller: { select: STAFF_SELECT },
        payments: {
          where: { kind: PaymentKind.DEPOSIT },
          select: { method: true },
          take: 1,
        },
        items: {
          // Món trong combo đi theo dòng combo cha, như khi nhập combo bằng SKU của combo.
          where: { lineType: { not: OrderLineType.COMBO_COMPONENT } },
          select: {
            sku: true,
            quantity: true,
            unitPrice: true,
            discountAmount: true,
            productItem: { select: { sku: true, productCode: true } },
            customization: {
              select: {
                lengthCm: true,
                widthCm: true,
                heightCm: true,
                material: true,
                color: true,
                fabricCode: true,
                note: true,
                specs: {
                  orderBy: { position: 'asc' },
                  select: { name: true, value: true, unit: true },
                },
              },
            },
          },
        },
      },
    });

    const lineCount = orders.reduce((n, o) => n + o.items.length, 0);
    if (lineCount > MAX_ORDER_EXPORT_ROWS) {
      throw tooLarge(
        `${lineCount} rows, the limit is ${MAX_ORDER_EXPORT_ROWS}`,
      );
    }

    const byId = new Map(orders.map((order) => [order.id, order]));
    const rows: OrderSheetRow[] = [];
    for (const id of ids) {
      const order = byId.get(id);
      if (!order) continue;
      const walkIn = order.customer.customerCode === WALK_IN_CUSTOMER_CODE;
      const deposit = Number(order.depositAmount ?? 0);
      const depositMethod = order.payments[0]?.method;
      // Thông tin đơn chỉ ghi ở dòng đầu, như file mẫu hướng dẫn.
      const head: OrderSheetRow = {
        branch: order.branch.location.name,
        fulfillmentType:
          FULFILLMENT_LABELS[order.fulfillmentType] ?? order.fulfillmentType,
        assignee: order.assignee ? staffLabel(order.assignee) : undefined,
        seller: order.seller ? staffLabel(order.seller) : undefined,
        priority: PRIORITY_LABELS[order.priority] ?? order.priority,
        customerPhone: walkIn ? undefined : order.customer.phone,
        customerName: walkIn ? undefined : order.customer.name,
        recipientName: order.recipientName,
        recipientPhone: order.recipientPhone,
        deliveryAddress: order.deliveryAddress,
        requestedDeliveryDate: order.requestedDeliveryDate
          ? dmy(order.requestedDeliveryDate)
          : undefined,
        shippingFee: positive(order.shippingFee),
        orderDiscount: positive(order.discountValue),
        deposit: deposit > 0 ? deposit : undefined,
        depositMethod:
          deposit > 0 && depositMethod
            ? (DEPOSIT_METHOD_LABELS[depositMethod] ?? depositMethod)
            : undefined,
        note: order.note,
      };
      order.items.forEach((line, index) => {
        rows.push({
          ...(index === 0 ? head : {}),
          group: order.code,
          sku: line.sku ?? line.productItem.sku ?? line.productItem.productCode,
          quantity: line.quantity,
          unitPrice: Number(line.unitPrice),
          lineDiscount: positive(line.discountAmount),
          customSpecs: line.customization
            ? specsText(line.customization)
            : undefined,
          customNote: line.customization?.note,
        });
      });
    }
    return rows;
  }
}

type Customization = {
  lengthCm: unknown;
  widthCm: unknown;
  heightCm: unknown;
  material: string | null;
  color: string | null;
  fabricCode: string | null;
  specs: { name: string; value: string; unit: string | null }[];
};

/** Cột "Thông số làm riêng" dạng "Tên: giá trị; Tên: giá trị"; dòng cũ chưa có specs thì lấy các trường riêng. */
function specsText(c: Customization): string | undefined {
  const pairs = c.specs.map(
    (s) => `${s.name}: ${s.value}${s.unit ? ` ${s.unit}` : ''}`,
  );
  if (pairs.length === 0) {
    const legacy: [string, unknown, string?][] = [
      ['Dài', c.lengthCm, 'cm'],
      ['Rộng', c.widthCm, 'cm'],
      ['Cao', c.heightCm, 'cm'],
      ['Chất liệu', c.material],
      ['Màu', c.color],
      ['Mã vải', c.fabricCode],
    ];
    for (const [name, value, unit] of legacy) {
      if (value === null || value === undefined || value === '') continue;
      const text = typeof value === 'string' ? value : String(Number(value));
      pairs.push(`${name}: ${text}${unit ? ` ${unit}` : ''}`);
    }
  }
  return pairs.length > 0 ? pairs.join('; ') : undefined;
}

function positive(value: unknown): number | undefined {
  const n = Number(value ?? 0);
  return n > 0 ? n : undefined;
}

/** Ngày `@db.Date` (nửa đêm UTC) thành dd/mm/yyyy như cột "Ngày giao mong muốn". */
function dmy(date: Date): string {
  const [y, m, d] = date.toISOString().slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

function tooLarge(detail: string): BadRequestException {
  return new BadRequestException({
    code: ErrorCode.EXCEL_EXPORT_TOO_LARGE,
    message: `The export has ${detail}`,
  });
}
