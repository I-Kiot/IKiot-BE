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
import { flattenCombo } from '../combo-expansion';
import { baseSkuOfCustom } from '../custom-sku';
import { loadComboGraph } from '../order-combo';

/** Giới hạn một file xuất. */
export const MAX_ORDER_EXPORT_ORDERS = 5000;
export const MAX_ORDER_EXPORT_ROWS = 20000;

const CUSTOMIZATION_SELECT = {
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
} as const;

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
            lineType: true,
            productItemId: true,
            quantity: true,
            unitPrice: true,
            discountAmount: true,
            isCustom: true,
            productItem: {
              select: { sku: true, productCode: true, productId: true },
            },
            customization: CUSTOMIZATION_SELECT,
            // Món làm riêng của dòng combo: ra file thành dòng phụ (cột "Thuộc combo"), như khi nhập.
            childItems: {
              where: { customization: { isNot: null } },
              orderBy: { id: 'asc' },
              select: {
                sku: true,
                productItem: {
                  select: { sku: true, productCode: true, productId: true },
                },
                customization: CUSTOMIZATION_SELECT,
              },
            },
          },
        },
      },
    });

    const lineCount = orders.reduce(
      (n, o) =>
        n + o.items.reduce((m, line) => m + 1 + line.childItems.length, 0),
      0,
    );
    if (lineCount > MAX_ORDER_EXPORT_ROWS) {
      throw tooLarge(
        `${lineCount} rows, the limit is ${MAX_ORDER_EXPORT_ROWS}`,
      );
    }

    const leaves = await this.comboLeaves(
      tenantId,
      orders.flatMap((order) =>
        order.items
          .filter(
            (line) =>
              line.lineType === OrderLineType.COMBO &&
              line.childItems.length > 0,
          )
          .map((line) => line.productItemId),
      ),
    );

    const standalone = await this.standaloneBases(
      tenantId,
      orders.flatMap((order) => order.items.filter((line) => line.isCustom)),
    );

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
        const sku =
          line.sku ?? line.productItem.sku ?? line.productItem.productCode;
        rows.push({
          ...(index === 0 ? head : {}),
          group: order.code,
          // Dòng làm riêng ghi SKU gốc: nhập lại thì làm riêng từ hàng gốc, không chồng thêm SKU riêng lên SKU riêng.
          sku: (line.isCustom && standalone.get(sku)) || sku,
          quantity: line.quantity,
          unitPrice: Number(line.unitPrice),
          lineDiscount: positive(line.discountAmount),
          customSpecs: line.customization
            ? specsText(line.customization)
            : undefined,
          customNote: line.customization?.note,
        });
        for (const part of line.childItems) {
          if (!part.customization) continue;
          rows.push({
            group: order.code,
            comboParent: sku,
            sku: baseSkuOf(part, leaves.get(line.productItemId) ?? []),
            customSpecs: specsText(part.customization),
            customNote: part.customization.note,
          });
        }
      });
    }
    return rows;
  }

  /**
   * SKU gốc của các dòng làm riêng đứng riêng, theo SKU riêng của dòng. Đọc ngược dạng SKU riêng rồi chỉ nhận khi SKU
   * gốc còn trong cửa hàng và cùng hàng hoá với SKU riêng; không thì dòng ghi SKU riêng như cũ.
   */
  private async standaloneBases(
    tenantId: string,
    lines: {
      sku: string | null;
      productItem: {
        sku: string | null;
        productCode: string;
        productId: string;
      };
    }[],
  ): Promise<Map<string, string>> {
    const wanted = new Map<string, { base: string; productId: string }>();
    for (const line of lines) {
      const own =
        line.sku ?? line.productItem.sku ?? line.productItem.productCode;
      const base = baseSkuOfCustom(own);
      if (base) {
        wanted.set(own, { base, productId: line.productItem.productId });
      }
    }
    if (wanted.size === 0) return new Map();
    const found = await this.prisma.productItem.findMany({
      where: {
        tenantId,
        sku: { in: [...new Set([...wanted.values()].map((w) => w.base))] },
      },
      select: { sku: true, productId: true },
    });
    const productOf = new Map(found.map((item) => [item.sku, item.productId]));
    const result = new Map<string, string>();
    for (const [own, { base, productId }] of wanted) {
      if (productOf.get(base) === productId) result.set(own, base);
    }
    return result;
  }

  /** Món lá (id, SKU, hàng hoá) của các combo, để tìm lại SKU gốc của món đã làm riêng. */
  private async comboLeaves(
    tenantId: string,
    comboIds: string[],
  ): Promise<Map<string, ComboLeafRef[]>> {
    const ids = [...new Set(comboIds)];
    const result = new Map<string, ComboLeafRef[]>();
    if (ids.length === 0) return result;
    const graph = await loadComboGraph(this.prisma, tenantId, ids);
    const flat = new Map<string, { id: string; sku: string | null }[]>();
    for (const id of ids) {
      try {
        flat.set(
          id,
          flattenCombo(id, graph).map(({ item }) => ({
            id: item.id,
            sku: item.sku,
          })),
        );
      } catch {
        // Combo không mở được nữa (đã sửa thành vòng): món của nó ra file bằng SKU riêng, bộ nhập sẽ báo.
        flat.set(id, []);
      }
    }
    const products = new Map(
      (
        await this.prisma.productItem.findMany({
          where: {
            tenantId,
            id: { in: [...flat.values()].flat().map((leaf) => leaf.id) },
          },
          select: { id: true, productId: true },
        })
      ).map((item) => [item.id, item.productId]),
    );
    for (const [id, list] of flat) {
      result.set(
        id,
        list.map((leaf) => ({ ...leaf, productId: products.get(leaf.id) })),
      );
    }
    return result;
  }
}

interface ComboLeafRef {
  id: string;
  sku: string | null;
  productId: string | undefined;
}

/**
 * SKU gốc của món làm riêng trong combo: file nhập cần SKU của món trong combo, còn dòng đơn chỉ còn SKU riêng. Đọc
 * ngược theo dạng SKU riêng (`baseSkuOfCustom`), không khớp thì lấy món duy nhất của combo cùng hàng hoá; vẫn không
 * ra thì ghi SKU riêng để bộ nhập báo thay vì đoán.
 */
function baseSkuOf(
  part: {
    sku: string | null;
    productItem: {
      sku: string | null;
      productCode: string;
      productId: string;
    };
  },
  leaves: readonly ComboLeafRef[],
): string {
  const own = part.sku ?? part.productItem.sku ?? part.productItem.productCode;
  const base = baseSkuOfCustom(own);
  if (base && leaves.some((leaf) => leaf.sku === base)) return base;
  const sameProduct = leaves.filter(
    (leaf) => leaf.productId === part.productItem.productId && leaf.sku,
  );
  return sameProduct.length === 1 ? (sameProduct[0].sku as string) : own;
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
