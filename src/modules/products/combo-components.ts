import {
  BadRequestException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client';
import { recordPriceChange } from './product-price-history';
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
 * Giá vốn combo = tổng `số lượng x giá vốn` các thành phần, không nhập tay (sẽ lệch khi món đổi giá).
 * Làm tròn 2 chữ số như cột DB để khớp tổng Decimal.
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
 * Kiểm đồ thị khi `comboId` chứa `edges`: combo đó và các combo trên phải còn bung được (`flattenCombo`).
 * Hàm thuần để test không cần DB; chặn lúc nhập thay vì lúc thanh toán.
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
 * Mọi thao tác đổi "combo chứa gì / món còn bán không" (ghi thành phần, ngừng, bật lại) phải xếp hàng qua
 * khoá này. Nếu không, hai thao tác cùng kiểm trên trạng thái cũ có thể cùng qua và cùng phá quy tắc.
 * Khoá theo transaction, tự nhả khi commit / rollback.
 */
export async function lockComboGraph(
  tx: Prisma.TransactionClient,
  tenantId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`combo-graph:${tenantId}`}::text))`;
}

/**
 * Ghi thành phần combo, thay danh sách cũ. Phải chạy dưới `lockComboGraph`, không thì hai lần sửa cùng kiểm
 * một đồ thị cũ có thể tạo vòng lặp. Người gọi kiểm `assertComponentsMatchType` trước.
 */
export async function writeComboComponents(
  tx: Prisma.TransactionClient,
  tenantId: string,
  comboId: string,
  components: ComboComponentInput[],
  actorId: string | null = null,
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

  // Nạp cả đồ thị một lần (shop ít combo) để kiểm vòng lặp và độ sâu.
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

  // Combo lồng đã lưu giá vốn đúng (`recomputeComboCosts` giữ), nên chỉ cần cộng một tầng.
  const costOf = new Map(
    items.map((item) => [item.id, Number(item.costPrice)]),
  );
  const comboBefore = await tx.productItem.findUniqueOrThrow({
    where: { id: comboId },
    select: { costPrice: true },
  });
  const derivedCost = comboCostOf(
    components.map((component) => ({
      quantity: component.quantity,
      costPrice: costOf.get(component.componentItemId)!,
    })),
  );
  await recordPriceChange(tx, {
    tenantId,
    productItemId: comboId,
    before: comboBefore,
    after: { costPrice: derivedCost },
    actorId,
  });
  await tx.productItem.update({
    where: { id: comboId },
    data: { costPrice: derivedCost },
  });
  await recomputeComboCosts(tx, tenantId, [comboId], actorId);
}

/**
 * Tính lại giá vốn combo phía trên `changedIds` (lưu sẵn, không tính lúc đọc), con trước cha.
 * Chạy trong transaction của người gọi để sửa và tính lại cùng rollback.
 */
export async function recomputeComboCosts(
  tx: Prisma.TransactionClient,
  tenantId: string,
  changedIds: readonly string[],
  actorId: string | null = null,
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

  // Bước 1 - bảng chỉ lưu "combo chứa món", nên đi từ món LÊN combo phải đảo chiều (parentsOf).
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

  // Bước 2 - gom combo cần giá mới bằng cách đi lên từ các món đổi. Combo đến bằng nhiều đường
  // (Phòng ăn qua Ghế và qua Bộ bàn ăn) chỉ được xử lý một lần.
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

  // Bước 3 - nạp giá một lần cho combo bị ảnh hưởng và món trực tiếp; món khác có giá đã lưu đúng.
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

  // Giá vốn lưu sẵn trước khi tính lại, cho lịch sử giá.
  const storedCosts = new Map(costs);

  // Bước 4 - giá mới của `id`: không bị ảnh hưởng thì lấy giá đã lưu. Bị ảnh hưởng thì tính từ món con
  // (đệ quy để combo con tính trước), ghi vào `costs` và bỏ khỏi `affected` để mỗi combo chỉ tính một lần.
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
  // `resolve` làm rỗng dần `affected`, nên phải sao chép danh sách id cần ghi trước.
  const toWrite = [...affected];
  for (const id of toWrite) {
    const cost = resolve(id);
    await recordPriceChange(tx, {
      tenantId,
      productItemId: id,
      before: { costPrice: storedCosts.get(id) ?? 0 },
      after: { costPrice: cost },
      actorId,
    });
    await tx.productItem.update({ where: { id }, data: { costPrice: cost } });
  }
}

/** `comboComponents` chỉ thuộc COMBO: COMBO cần ≥1 món, loại khác không được có (danh sách rỗng ở loại khác vẫn hợp lệ). */
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
