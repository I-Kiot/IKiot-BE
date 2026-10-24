import {
  BadRequestException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client';
import { ErrorCode } from '../../common/errors/error-codes';
import {
  ProductItemType,
  ProductStatus,
} from '../../common/constants/product-status';
import { flattenCombo, type ComboEdge } from '../orders/combo-expansion';

export interface ComboComponentInput {
  componentItemId: string;
  quantity: number;
}

/**
 * A combo's cost is what its parts cost: the sum of `quantity x costPrice` over its components. Never
 * typed in - a hand-entered figure drifts from the parts the moment one of them is repriced. Rounded
 * to 2 places like the column, so a Decimal sum and this one cannot disagree by a fraction.
 */
export function comboCostOf(
  components: readonly { quantity: number; costPrice: number }[],
): number {
  const total = components.reduce(
    (sum, part) => sum + part.quantity * part.costPrice,
    0,
  );
  return Math.round(total * 100) / 100;
}

const invalid = (message: string) =>
  new BadRequestException({ code: ErrorCode.PRODUCT_COMBO_INVALID, message });

/** Every combo that contains `id`, directly or through another combo. */
function ancestorsOf(
  id: string,
  childrenOf: ReadonlyMap<string, readonly ComboEdge[]>,
): string[] {
  const parentsOf = new Map<string, string[]>();
  for (const [comboId, edges] of childrenOf) {
    for (const edge of edges) {
      const parents = parentsOf.get(edge.componentItem.id) ?? [];
      parents.push(comboId);
      parentsOf.set(edge.componentItem.id, parents);
    }
  }
  const seen = new Set<string>();
  const queue = [id];
  while (queue.length > 0) {
    for (const parent of parentsOf.get(queue.pop()!) ?? []) {
      if (seen.has(parent)) continue;
      seen.add(parent);
      queue.push(parent);
    }
  }
  seen.delete(id);
  return [...seen];
}

/**
 * Checks the tenant's combo graph as it would be with `comboId` holding `edges`: the combo itself
 * and every combo above it must still flatten (`flattenCombo` - no cycle, no empty combo, no nesting
 * past `MAX_COMBO_DEPTH`). Pure, so the rules are unit-tested without a database. The order flow
 * runs the same `flattenCombo` when it sells the combo; refusing here means a bad catalogue is caught
 * when it is typed, not when a customer is at the till.
 */
export function assertComboGraph(
  comboId: string,
  edges: readonly ComboEdge[],
  childrenOf: ReadonlyMap<string, readonly ComboEdge[]>,
): void {
  const graph = new Map(childrenOf);
  graph.set(comboId, edges);
  for (const id of [comboId, ...ancestorsOf(comboId, graph)]) {
    try {
      flattenCombo(id, graph);
    } catch (error) {
      if (error instanceof HttpException) {
        const body = error.getResponse() as { message?: string };
        throw invalid(body.message ?? 'Invalid combo');
      }
      throw error;
    }
  }
}

/** Throws `PRODUCT_COMBO_COMPONENT_DISCONTINUED`, naming the SKUs, when any of `items` belongs to a discontinued product. */
export function assertNoDiscontinuedComponent(
  items: { id: string; sku: string | null; productStatus: string }[],
): void {
  const dead = items.filter(
    (item) => item.productStatus === ProductStatus.DISCONTINUED,
  );
  if (dead.length === 0) return;
  throw new BadRequestException({
    code: ErrorCode.PRODUCT_COMBO_COMPONENT_DISCONTINUED,
    message: `Combo component of a discontinued product: ${dead
      .map((item) => item.sku ?? item.id)
      .join(', ')}`,
  });
}

/**
 * Serialises everything that reads and then changes "which combo holds what, and is it still sold"
 * for one tenant: writing components, discontinuing a product, switching one back on. Each of those
 * checks the graph or the statuses and then writes, so two of them checked against the same old state
 * could each pass and together break the rule. Transaction-scoped: released at commit / rollback.
 */
export async function lockComboGraph(
  tx: Prisma.TransactionClient,
  tenantId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`combo-graph:${tenantId}`}::text))`;
}

/**
 * Validates and writes a combo's components, replacing what it had. Callers run
 * `assertComponentsMatchType` first - that is the one place saying a COMBO needs at least one. The
 * components must be variants of this tenant whose product is not discontinued, each named once. A
 * component may itself be a COMBO (nested combo); the whole graph is re-checked with
 * `assertComboGraph`.
 *
 * Runs inside the caller's transaction under `lockComboGraph`: two edits checked against the same old
 * graph (A ← B and B ← A at once) would otherwise each pass and together make a cycle.
 */
export async function writeComboComponents(
  tx: Prisma.TransactionClient,
  tenantId: string,
  comboId: string,
  components: ComboComponentInput[],
): Promise<void> {
  await lockComboGraph(tx, tenantId);

  const ids = components.map((component) => component.componentItemId);
  if (new Set(ids).size !== ids.length) {
    throw invalid('A component is listed twice in the combo');
  }
  if (ids.includes(comboId)) {
    throw invalid('A combo cannot contain itself');
  }

  const items = await tx.productItem.findMany({
    where: { tenantId, id: { in: ids } },
    select: {
      id: true,
      sku: true,
      productName: true,
      vat: true,
      itemType: true,
      costPrice: true,
      product: { select: { status: true } },
    },
  });
  if (items.length !== ids.length) {
    throw new NotFoundException({
      code: ErrorCode.PRODUCT_ITEM_NOT_FOUND,
      message: 'A combo component was not found',
    });
  }
  assertNoDiscontinuedComponent(
    items.map((item) => ({ ...item, productStatus: item.product.status })),
  );

  // Một shop có ít combo; nạp cả đồ thị một lần để kiểm vòng lặp và độ sâu cho mọi combo phía trên.
  const rows = await tx.comboComponent.findMany({
    where: { comboItem: { tenantId } },
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
  const childrenOf = new Map<string, ComboEdge[]>();
  for (const row of rows) {
    const edges = childrenOf.get(row.comboItemId) ?? [];
    edges.push(row);
    childrenOf.set(row.comboItemId, edges);
  }
  const byId = new Map(
    items.map(({ product: _product, costPrice: _cost, ...item }) => [
      item.id,
      item,
    ]),
  );
  assertComboGraph(
    comboId,
    components.map((component) => ({
      comboItemId: comboId,
      quantity: component.quantity,
      componentItem: byId.get(component.componentItemId)!,
    })),
    childrenOf,
  );

  await tx.comboComponent.deleteMany({ where: { comboItemId: comboId } });
  await tx.comboComponent.createMany({
    data: components.map((component) => ({
      comboItemId: comboId,
      componentItemId: component.componentItemId,
      quantity: component.quantity,
    })),
  });

  // A nested combo's own stored cost is already the sum of its parts (kept current by
  // `recomputeComboCosts`), so one level of arithmetic here is enough.
  const costOf = new Map(
    items.map((item) => [item.id, Number(item.costPrice)]),
  );
  await tx.productItem.update({
    where: { id: comboId },
    data: {
      costPrice: comboCostOf(
        components.map((component) => ({
          quantity: component.quantity,
          costPrice: costOf.get(component.componentItemId)!,
        })),
      ),
    },
  });
  await recomputeComboCosts(tx, tenantId, [comboId]);
}

/**
 * Re-prices every combo above `changedIds` after a component's cost moved (or a combo's own did), so
 * a stored combo cost never goes stale. Walks the tenant's graph once in memory; the graph is acyclic
 * (`assertComboGraph`), so each combo is priced after its parts.
 */
export async function recomputeComboCosts(
  tx: Prisma.TransactionClient,
  tenantId: string,
  changedIds: readonly string[],
): Promise<void> {
  const rows = await tx.comboComponent.findMany({
    where: { comboItem: { tenantId } },
    select: {
      comboItemId: true,
      componentItemId: true,
      quantity: true,
    },
  });
  if (rows.length === 0) return;

  const partsOf = new Map<
    string,
    { componentItemId: string; quantity: number }[]
  >();
  const parentsOf = new Map<string, string[]>();
  for (const row of rows) {
    const parts = partsOf.get(row.comboItemId) ?? [];
    parts.push(row);
    partsOf.set(row.comboItemId, parts);
    const parents = parentsOf.get(row.componentItemId) ?? [];
    parents.push(row.comboItemId);
    parentsOf.set(row.componentItemId, parents);
  }

  const affected = new Set<string>();
  const queue = [...changedIds];
  while (queue.length > 0) {
    for (const parent of parentsOf.get(queue.pop()!) ?? []) {
      if (affected.has(parent)) continue;
      affected.add(parent);
      queue.push(parent);
    }
  }
  if (affected.size === 0) return;

  const involved = new Set<string>(affected);
  for (const id of affected) {
    for (const part of partsOf.get(id) ?? [])
      involved.add(part.componentItemId);
  }
  const costs = new Map(
    (
      await tx.productItem.findMany({
        where: { tenantId, id: { in: [...involved] } },
        select: { id: true, costPrice: true },
      })
    ).map((item) => [item.id, Number(item.costPrice)]),
  );

  const resolve = (id: string): number => {
    if (!affected.has(id)) return costs.get(id) ?? 0;
    const cost = comboCostOf(
      (partsOf.get(id) ?? []).map((part) => ({
        quantity: part.quantity,
        costPrice: resolve(part.componentItemId),
      })),
    );
    costs.set(id, cost);
    affected.delete(id);
    return cost;
  };
  const toWrite = [...affected];
  for (const id of toWrite) {
    const cost = resolve(id);
    await tx.productItem.update({ where: { id }, data: { costPrice: cost } });
  }
}

/** `comboComponents` belongs to a COMBO only: at least one on a COMBO, none on anything else (an empty list on a non-combo is no components, so it passes). */
export function assertComponentsMatchType(
  itemType: string,
  components: ComboComponentInput[] | undefined,
): void {
  if (itemType === ProductItemType.COMBO && !components?.length) {
    throw invalid('A combo needs at least one component');
  }
  if (itemType !== ProductItemType.COMBO && components?.length) {
    throw invalid('Only a COMBO variant has components');
  }
}
