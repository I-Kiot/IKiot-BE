import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  INVOICE_NUMBER_PREFIX,
  InvoiceStatus,
  InvoiceType,
} from '../../common/constants/invoice-status';
import { ErrorCode } from '../../common/errors/error-codes';
import {
  nextInvoiceNumber,
  returnedValue,
  saleLines,
  saleTotal,
} from './invoice-math';

type Tx = Prisma.TransactionClient;

const ORDER_FOR_INVOICE = {
  id: true,
  tenantId: true,
  subtotal: true,
  vatTotal: true,
  grandTotal: true,
  userId: true,
  customer: { select: { name: true, address: true } },
  items: {
    where: { parentItemId: null },
    orderBy: { id: 'asc' },
    select: {
      id: true,
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
 * Every order has one SALE invoice. It is PENDING from the moment the order exists and is ISSUED -
 * numbered, with its lines frozen - when the order is COMPLETED, by every route that completes one.
 * An issued invoice is never edited: goods that come back afterwards produce an ADJUSTMENT with a
 * negative total. All methods take the caller's transaction, so an invoice can never be ISSUED for
 * an order whose completion rolled back (or the other way round).
 */
@Injectable()
export class InvoiceService {
  constructor(private readonly prisma: PrismaService) {}

  /** The order's invoice, PENDING; a no-op when it already has a live one. */
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

  /** PENDING -> ISSUED for a COMPLETED order. Idempotent: a second call (a replayed webhook, two routes racing) returns the invoice already issued. */
  async issueForOrder(tx: Tx, orderId: string, actorId?: string | null) {
    const order = await this.loadOrder(tx, orderId);
    const existing = await this.liveSale(tx, orderId);
    if (existing?.status === InvoiceStatus.ISSUED) return existing;

    const lines = order.items.map((item) => ({
      ...item,
      unitPrice: Number(item.unitPrice),
      lineTotal: Number(item.lineTotal),
    }));
    const kept = saleLines(lines);
    const total = saleTotal(Number(order.grandTotal), lines);
    const number = await this.allocateNumber(
      tx,
      order.tenantId,
      InvoiceType.SALE,
    );
    const now = new Date();
    const lineRows = kept.map(({ line, quantity, amount }, position) => ({
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
      position,
    }));

    if (existing) {
      // Claimed on PENDING: two routes completing the same order can't both number it.
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

    // An order that never got a PENDING invoice (created before invoices existed): issue directly.
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

  /** The order was cancelled (or came back whole) before it was ever completed: the invoice was never issued, so it is withdrawn rather than adjusted. */
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
   * Goods came back. Once the sale invoice is ISSUED that is an ADJUSTMENT for their value (negative);
   * while it is still PENDING nothing is written - `issueForOrder` nets the returned quantity out.
   * `items` omitted means the whole order (the till's RETURNED).
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
    const picked = saleLinesRows.flatMap((line) => {
      const quantity = items
        ? (wanted.get(line.orderItemId ?? '') ?? 0)
        : line.quantity;
      if (quantity <= 0) return [];
      const value = returnedValue({
        quantity: line.quantity,
        lineTotal: Number(line.amount),
        returned: Math.min(quantity, line.quantity),
      });
      return [{ line, quantity: Math.min(quantity, line.quantity), value }];
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
            position,
          })),
        },
      },
    });
  }

  /** Numbers are a per-shop running count; the advisory lock serialises two issues in one shop so they can't read the same highest number. */
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
