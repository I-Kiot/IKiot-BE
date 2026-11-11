import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  INVOICE_NUMBER_PREFIX,
  InvoiceStatus,
  InvoiceType,
} from '../../common/constants/invoice-status';
import { ErrorCode } from '../../common/errors/error-codes';
import { nextInvoiceNumber, saleLines, saleTotal } from './invoice-math';
import { sliceValue, toDong } from '../../common/utils/money';

type Tx = Prisma.TransactionClient;

const ORDER_FOR_INVOICE = {
  id: true,
  tenantId: true,
  subtotal: true,
  vatTotal: true,
  grandTotal: true,
  shippingFee: true,
  discountType: true,
  discountValue: true,
  userId: true,
  customer: { select: { name: true, address: true } },
  items: {
    where: { parentItemId: null },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      lineType: true,
      productItemId: true,
      productName: true,
      sku: true,
      variantLabel: true,
      quantity: true,
      returnedQuantity: true,
      unitPrice: true,
      vatRate: true,
      lineTotal: true,
    },
  },
} as const satisfies Prisma.OrderSelect;

/**
 * Mỗi đơn có một hoá đơn BÁN, ở trạng thái PENDING từ khi đơn tồn tại; chuyển sang ISSUED (đánh số, khoá dòng) khi đơn COMPLETED. ISSUED không bao giờ bị sửa: hàng trả sau đó sinh ADJUSTMENT âm. Mọi method nhận transaction của caller, để hoá đơn không ISSUED khi việc hoàn thành đơn bị rollback.
 */
@Injectable()
export class InvoiceService {
  constructor(private readonly prisma: PrismaService) {}

  async ensurePending(tx: Tx, orderId: string) {
    const live = await this.liveSale(tx, orderId);
    if (live) return live;
    const order = await this.loadOrder(tx, orderId);
    return tx.invoice.create({
      data: {
        tenantId: order.tenantId,
        orderId: order.id,
        type: InvoiceType.SALE,
        status: InvoiceStatus.PENDING,
        subtotal: order.subtotal,
        vatAmount: order.vatTotal,
        total: order.grandTotal,
        buyerName: order.customer.name,
        buyerAddress: order.customer.address,
        createdById: order.userId,
      },
    });
  }

  /** PENDING -> ISSUED cho đơn COMPLETED. Idempotent: lần gọi thứ hai (webhook gửi lại, hai route chạy đua) trả về hoá đơn đã ISSUED. */
  async issueForOrder(tx: Tx, orderId: string, actorId?: string | null) {
    const order = await this.loadOrder(tx, orderId);
    const existing = await this.liveSale(tx, orderId);
    if (existing?.status === InvoiceStatus.ISSUED) return existing;

    const lines = order.items.map((item) => ({
      ...item,
      unitPrice: Number(item.unitPrice),
      lineTotal: Number(item.lineTotal),
    }));
    const kept = saleLines(order, lines);
    const shippingFee = Math.max(0, toDong(order.shippingFee));
    const total = saleTotal(kept, shippingFee);
    const number = await this.allocateNumber(
      tx,
      order.tenantId,
      InvoiceType.SALE,
    );
    const now = new Date();
    const lineRows: Prisma.InvoiceLineUncheckedCreateWithoutInvoiceInput[] =
      kept.map(({ line, quantity, amount, discount }, position) => ({
        orderItemId: line.id,
        description: [
          line.productName ?? line.sku ?? 'Sản phẩm',
          line.variantLabel,
        ]
          .filter(Boolean)
          .join(' - '),
        quantity,
        unitPrice: line.unitPrice,
        vatRate: line.vatRate ?? 0,
        amount,
        discountAmount: discount,
        position,
      }));
    // Phí vận chuyển thu của khách là một dòng của hoá đơn (không gắn dòng đơn), để Σ dòng = tổng hoá đơn.
    if (shippingFee > 0) {
      lineRows.push({
        orderItemId: null,
        description: 'Phí vận chuyển',
        quantity: 1,
        unitPrice: shippingFee,
        vatRate: 0,
        amount: shippingFee,
        discountAmount: 0,
        position: lineRows.length,
      });
    }

    if (existing) {
      // Khoá bằng điều kiện status PENDING: hai route cùng hoàn thành một đơn không thể cùng đánh số.
      const claimed = await tx.invoice.updateMany({
        where: { id: existing.id, status: InvoiceStatus.PENDING },
        data: {
          status: InvoiceStatus.ISSUED,
          invoiceNumber: number,
          issuedAt: now,
          subtotal: order.subtotal,
          vatAmount: order.vatTotal,
          total,
          buyerName: order.customer.name,
          buyerAddress: order.customer.address,
        },
      });
      if (claimed.count !== 1) {
        return tx.invoice.findUniqueOrThrow({ where: { id: existing.id } });
      }
      await tx.invoiceLine.createMany({
        data: lineRows.map((row) => ({ ...row, invoiceId: existing.id })),
      });
      return tx.invoice.findUniqueOrThrow({ where: { id: existing.id } });
    }

    // Đơn chưa có hoá đơn PENDING (tạo trước khi có hoá đơn): xuất thẳng.
    return tx.invoice.create({
      data: {
        tenantId: order.tenantId,
        orderId: order.id,
        type: InvoiceType.SALE,
        status: InvoiceStatus.ISSUED,
        invoiceNumber: number,
        issuedAt: now,
        subtotal: order.subtotal,
        vatAmount: order.vatTotal,
        total,
        buyerName: order.customer.name,
        buyerAddress: order.customer.address,
        createdById: actorId ?? order.userId,
        lines: { create: lineRows },
      },
    });
  }

  /** Đơn bị huỷ (hoặc trả hết) trước khi hoàn thành: hoá đơn chưa từng ISSUED nên bị rút lại, không điều chỉnh. */
  async voidPending(tx: Tx, orderId: string) {
    await tx.invoice.updateMany({
      where: {
        orderId,
        type: InvoiceType.SALE,
        status: InvoiceStatus.PENDING,
      },
      data: { status: InvoiceStatus.CANCELLED },
    });
  }

  /**
   * Hàng được trả. Khi hoá đơn BÁN đã ISSUED thì ghi ADJUSTMENT âm theo giá trị trả; còn PENDING thì không ghi gì, vì `issueForOrder` đã trừ số lượng trả.
   * `items` rỗng nghĩa là trả cả đơn.
   */
  async adjustForReturn(
    tx: Tx,
    orderId: string,
    reason: string,
    actorId: string | null,
    items?: { orderItemId: string; quantity: number }[],
  ) {
    const sale = await this.liveSale(tx, orderId);
    if (!sale || sale.status !== InvoiceStatus.ISSUED) return null;

    const saleLinesRows = await tx.invoiceLine.findMany({
      where: { invoiceId: sale.id },
      orderBy: { position: 'asc' },
    });
    const wanted = new Map(items?.map((i) => [i.orderItemId, i.quantity]));
    // Số đã điều chỉnh ở các hoá đơn điều chỉnh trước, để các lát trả cộng lại đúng bằng giá trị dòng (không trôi từng lần làm tròn).
    const earlier = await tx.invoiceLine.findMany({
      where: {
        invoice: {
          originalInvoiceId: sale.id,
          type: InvoiceType.ADJUSTMENT,
          status: InvoiceStatus.ISSUED,
        },
        orderItemId: { not: null },
      },
      select: { orderItemId: true, quantity: true },
    });
    const already = new Map<string, number>();
    for (const row of earlier) {
      already.set(
        row.orderItemId!,
        (already.get(row.orderItemId!) ?? 0) + row.quantity,
      );
    }
    const picked = saleLinesRows.flatMap((line) => {
      // Dòng phí vận chuyển (không gắn dòng đơn) không hoàn khi trả hàng.
      if (!line.orderItemId) return [];
      const requested = items
        ? (wanted.get(line.orderItemId) ?? 0)
        : line.quantity;
      const before = already.get(line.orderItemId) ?? 0;
      const quantity = Math.min(requested, line.quantity - before);
      if (quantity <= 0) return [];
      const value = sliceValue(
        toDong(line.amount),
        line.quantity,
        before,
        quantity,
      );
      return [{ line, quantity, value }];
    });
    if (picked.length === 0) return null;

    const total = picked.reduce((sum, p) => sum + p.value, 0);
    const number = await this.allocateNumber(
      tx,
      sale.tenantId,
      InvoiceType.ADJUSTMENT,
    );
    return tx.invoice.create({
      data: {
        tenantId: sale.tenantId,
        orderId,
        type: InvoiceType.ADJUSTMENT,
        originalInvoiceId: sale.id,
        status: InvoiceStatus.ISSUED,
        invoiceNumber: number,
        issuedAt: new Date(),
        subtotal: -total,
        vatAmount: 0,
        total: -total,
        reason,
        buyerName: sale.buyerName,
        buyerAddress: sale.buyerAddress,
        createdById: actorId,
        lines: {
          create: picked.map((p, position) => ({
            orderItemId: p.line.orderItemId,
            description: p.line.description,
            quantity: p.quantity,
            unitPrice: p.line.unitPrice,
            vatRate: p.line.vatRate,
            amount: -p.value,
            discountAmount: 0,
            position,
          })),
        },
      },
    });
  }

  /** Số hoá đơn đếm tăng theo từng shop; advisory lock tuần tự hoá hai lần phát hành trong cùng shop để không đọc trùng số lớn nhất. */
  private async allocateNumber(
    tx: Tx,
    tenantId: string,
    type: InvoiceType,
  ): Promise<string> {
    const prefix = INVOICE_NUMBER_PREFIX[type];
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`invoice:${tenantId}`}::text))`;
    const rows = await tx.$queryRaw<{ highest: number | null }[]>`
      SELECT max(substring("invoice_number" from (${prefix.length + 1})::int)::int) AS highest
      FROM "invoices"
      WHERE "tenant_id" = ${tenantId}
        AND "invoice_number" ~ (${`^${prefix}[0-9]+$`})::text`;
    return nextInvoiceNumber(prefix, rows[0]?.highest ?? 0);
  }

  private liveSale(tx: Tx, orderId: string) {
    return tx.invoice.findFirst({
      where: {
        orderId,
        type: InvoiceType.SALE,
        status: { not: InvoiceStatus.CANCELLED },
      },
    });
  }

  private async loadOrder(tx: Tx, orderId: string) {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: ORDER_FOR_INVOICE,
    });
    if (!order) {
      throw new NotFoundException({
        code: ErrorCode.ORDER_NOT_FOUND,
        message: 'Order not found',
      });
    }
    return order;
  }
}
