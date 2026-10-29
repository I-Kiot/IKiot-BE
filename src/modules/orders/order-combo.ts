import { randomUUID } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client';
import {
  OrderItemStatus,
  OrderLineType,
} from '../../common/constants/order-status';
import { ErrorCode } from '../../common/errors/error-codes';
import {
  type ComboEdge,
  type ComboLeaf,
  flattenCombo,
  MAX_COMBO_DEPTH,
} from './combo-expansion';
import type { PricedLine } from './order-pricing.service';

/** Anything that can read `combo_components`: `PrismaService` or a transaction client. */
export type ComboGraphReader = Pick<Prisma.TransactionClient, 'comboComponent'>;

/**
 * The combo graph under `comboIds`: for every combo reachable from them, what it directly contains.
 * Loaded one nesting level per query - never one query per combo - and every level is bounded by
 * `MAX_COMBO_DEPTH`. Shared by the order side (expanding a sold combo into lines) and the catalogue
 * side (how many sets of a combo are on the shelf), which must walk the graph the same way.
 */
export async function loadComboGraph(
  db: ComboGraphReader,
  tenantId: string,
  comboIds: readonly string[],
): Promise<Map<string, ComboEdge[]>> {
  const childrenOf = new Map<string, ComboEdge[]>();
  let frontier = [...comboIds];
  for (let depth = 0; frontier.length > 0; depth++) {
    if (depth > MAX_COMBO_DEPTH) {
      throw new BadRequestException({
        code: ErrorCode.ORDER_COMBO_INVALID,
        message: `A combo nests deeper than ${MAX_COMBO_DEPTH} levels`,
      });
    }
    const edges = await db.comboComponent.findMany({
      where: { comboItemId: { in: frontier }, comboItem: { tenantId } },
      select: {
        comboItemId: true,
        quantity: true,
        componentItem: {
          select: {
            id: true,
            sku: true,
            productName: true,
            vat: true,
            itemType: true,
          },
        },
      },
    });
    for (const id of frontier) childrenOf.set(id, []);
    for (const edge of edges) childrenOf.get(edge.comboItemId)!.push(edge);
    // A sub-combo already loaded (or a cycle back to one) is not fetched again; `flattenCombo` reports the cycle.
    frontier = [
      ...new Set(
        edges
          .map((edge) => edge.componentItem)
          .filter(
            (item) =>
              item.itemType === OrderLineType.COMBO && !childrenOf.has(item.id),
          )
          .map((item) => item.id),
      ),
    ];
  }
  return childrenOf;
}

/** What each COMBO line in the order finally contains, keyed by the combo's variant id (`flattenCombo`). */
export async function expandCombos(
  db: ComboGraphReader,
  tenantId: string,
  lines: readonly Pick<PricedLine, 'productItemId' | 'itemType'>[],
): Promise<Map<string, ComboLeaf[]>> {
  const comboIds = [
    ...new Set(
      lines
        .filter((line) => line.itemType === OrderLineType.COMBO)
        .map((line) => line.productItemId),
    ),
  ];
  const childrenOf = await loadComboGraph(db, tenantId, comboIds);
  return new Map(comboIds.map((id) => [id, flattenCombo(id, childrenOf)]));
}

/**
 * The order's lines as rows: each priced line, and under every COMBO line one child per leaf it
 * finally contains (nested combos already flattened), at price 0 - the combo line carries the money,
 * the children carry the stock and ship from the combo's location. A child is COMBO_COMPONENT, or
 * SERVICE when the leaf is a service; SERVICE lines need no goods, so they ship from nowhere.
 *
 * `sourceLocationId` may be null for every line: the till (`OrderService.createPosSale`) deducts at
 * its own branch on the spot and has never stored a ship-from location.
 */
export function buildOrderItemRows(
  lines: readonly (PricedLine & { sourceLocationId: string | null })[],
  components: ReadonlyMap<string, ComboLeaf[]>,
  lineTotalOf: (line: PricedLine) => number,
): Prisma.OrderItemCreateManyOrderInput[] {
  const rows: Prisma.OrderItemCreateManyOrderInput[] = [];
  for (const line of lines) {
    const id = randomUUID();
    const isCombo = line.itemType === OrderLineType.COMBO;
    rows.push({
      id,
      productItemId: line.productItemId,
      status: OrderItemStatus.PENDING,
      lineType: line.itemType,
      // A COMBO line is priced only, so it has no stock to locate; its children do.
      sourceLocationId:
        isCombo || line.itemType === OrderLineType.SERVICE
          ? null
          : line.sourceLocationId,
      productName: line.productName,
      sku: line.sku,
      listUnitPrice: line.listUnitPrice,
      vatRate: line.vatRate,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      discountAmount: line.discountAmount,
      lineTotal: lineTotalOf(line),
    });
    if (!isCombo) continue;
    for (const leaf of components.get(line.productItemId) ?? []) {
      const isService = leaf.item.itemType === OrderLineType.SERVICE;
      rows.push({
        productItemId: leaf.item.id,
        status: OrderItemStatus.PENDING,
        lineType: isService
          ? OrderLineType.SERVICE
          : OrderLineType.COMBO_COMPONENT,
        parentItemId: id,
        sourceLocationId: isService ? null : line.sourceLocationId,
        productName: leaf.item.productName,
        sku: leaf.item.sku,
        vatRate: leaf.item.vat as Prisma.Decimal | null,
        quantity: line.quantity * leaf.quantity,
        listUnitPrice: 0,
        unitPrice: 0,
        discountAmount: 0,
        lineTotal: 0,
      });
    }
  }
  return rows;
}
