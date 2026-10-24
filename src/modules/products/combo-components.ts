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
 * Giá vốn combo bằng giá vốn các món của nó: tổng `số lượng x giá vốn` của các thành phần. Không
 * bao giờ nhập tay - số gõ tay sẽ lệch khỏi các món ngay khi một món đổi giá. Làm tròn 2 chữ số
 * như cột trong database, để tổng Decimal và tổng ở đây không lệch nhau một phần lẻ.
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

/** Mọi combo chứa `id`, trực tiếp hoặc qua combo khác. */
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
 * Kiểm tra đồ thị combo của shop như thể `comboId` đang chứa `edges`: chính combo đó và mọi combo
 * phía trên nó vẫn phải "bung" được (`flattenCombo` - không vòng lặp, không combo rỗng, không lồng
 * quá `MAX_COMBO_DEPTH`). Hàm thuần nên test đơn vị được mà không cần database. Luồng bán hàng chạy
 * cùng `flattenCombo` khi bán combo; chặn ở đây nghĩa là danh mục sai bị bắt lúc nhập, không phải
 * lúc khách đang thanh toán.
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

/** Ném `PRODUCT_COMBO_COMPONENT_DISCONTINUED`, kèm SKU, khi có món trong `items` thuộc sản phẩm đã ngừng sản xuất. */
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
 * Xếp hàng mọi thao tác đọc rồi mới đổi "combo nào chứa gì, và món đó còn bán không" của một
 * shop: ghi thành phần, ngừng một sản phẩm, bật lại một sản phẩm. Mỗi thao tác đó kiểm tra đồ thị
 * hoặc trạng thái rồi mới ghi, nên hai thao tác cùng kiểm theo trạng thái cũ có thể cùng qua và
 * cùng nhau phá quy tắc. Khoá theo transaction: tự nhả khi commit / rollback.
 */
export async function lockComboGraph(
  tx: Prisma.TransactionClient,
  tenantId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`combo-graph:${tenantId}`}::text))`;
}

/**
 * Kiểm tra rồi ghi thành phần của một combo, thay cho danh sách cũ. Người gọi chạy
 * `assertComponentsMatchType` trước - đó là nơi duy nhất nói COMBO cần ít nhất một món. Các món
 * phải là phiên bản của shop này, thuộc sản phẩm chưa ngừng sản xuất, mỗi món chỉ nêu một lần.
 * Một món có thể là COMBO khác (combo lồng nhau); cả đồ thị được kiểm lại bằng `assertComboGraph`.
 * Sau khi ghi, giá vốn của combo được tính lại từ các món, rồi `recomputeComboCosts` sửa các combo
 * phía trên.
 *
 * Chạy trong transaction của người gọi, dưới `lockComboGraph`: hai lần sửa cùng kiểm theo một đồ
 * thị cũ (A ← B và B ← A cùng lúc) sẽ cùng qua và cùng nhau tạo vòng lặp.
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

  // Món là combo lồng thì giá vốn đã lưu của nó vốn là tổng các món của nó (luôn được
  // `recomputeComboCosts` giữ đúng), nên ở đây chỉ cần cộng một tầng.
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
 * Tính lại giá vốn của mọi combo nằm phía trên `changedIds`, để giá vốn combo đã lưu không bị cũ.
 *
 * Vì sao cần: `costPrice` của combo là số lưu sẵn (tổng số lượng x giá vốn từng món), không tính
 * lúc đọc. Khi giá vốn một món đổi, mọi combo chứa món đó - trực tiếp hoặc qua combo khác - đều
 * lỗi thời. Ví dụ: Phòng ăn = 1 Bộ bàn ăn + 2 Ghế, Bộ bàn ăn = 1 Bàn + 6 Ghế. Khi giá Ghế đổi phải
 * sửa Bộ bàn ăn trước, rồi mới tới Phòng ăn (dùng giá Bộ bàn ăn mới).
 *
 * Cách làm, 4 bước, đều chạy trên một bản đồ thị combo của shop nạp sẵn trong bộ nhớ (đọc một lần,
 * không query theo từng combo):
 *   1. Lập chỉ mục đồ thị hai chiều (`partsOf` = combo gồm những món nào, `parentsOf` = món nằm
 *      trong những combo nào).
 *   2. Đi LÊN từ `changedIds` bằng `parentsOf` để gom mọi combo cần tính lại giá.
 *   3. Đọc giá vốn hiện tại của các combo đó và của các món trực tiếp của chúng.
 *   4. Tính giá từng combo từ các món của nó (`resolve`), món con trước, rồi ghi xuống.
 *
 * Bản thân `changedIds` không bị tính lại - giá của chúng đã đúng, chỉ là điểm xuất phát. Đồ thị
 * không có vòng lặp (`assertComboGraph` chặn khi ghi thành phần), nên đệ quy ở bước 4 luôn dừng.
 *
 * Chạy trong transaction của người gọi: sửa bị rollback thì việc tính lại cũng rollback theo.
 */
export async function recomputeComboCosts(
  tx: Prisma.TransactionClient,
  tenantId: string,
  changedIds: readonly string[],
): Promise<void> {
  // Mỗi dòng là một cặp "combo X chứa món Y, số lượng Q", cho cả shop.
  const rows = await tx.comboComponent.findMany({
    where: { comboItem: { tenantId } },
    select: {
      comboItemId: true,
      componentItemId: true,
      quantity: true,
    },
  });
  if (rows.length === 0) return;

  // Bước 1 - lập chỉ mục đồ thị theo hai chiều. Bảng chỉ lưu "combo chứa món", nên muốn đi từ một
  // món LÊN các combo chứa nó thì phải đảo chiều.
  //   partsOf:   Bộ bàn ăn -> [{Bàn, 1}, {Ghế, 6}]      (đi xuống: nó gồm những gì?)
  //   parentsOf: Ghế       -> [Bộ bàn ăn, Phòng ăn]      (đi lên: nó được dùng ở đâu?)
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

  // Bước 2 - tìm mọi combo cần giá mới: xuất phát từ các món vừa đổi, cứ đi lên các combo chứa
  // chúng. Combo đã có trong `affected` thì bỏ qua, nên combo đến được bằng hai đường (VD: Phòng
  // ăn qua Ghế và qua Bộ bàn ăn) chỉ được xử lý một lần.
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

  // Bước 3 - nạp giá vốn cần dùng bằng một query: chính các combo bị ảnh hưởng và mọi món trực
  // tiếp của chúng. Món không bị ảnh hưởng (hàng thường, hoặc combo không đổi) có giá đã lưu vốn
  // đúng, nên dùng nguyên.
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

  // Bước 4 - giá vốn mới nhất của `id`.
  //   - Không bị ảnh hưởng: giá đã lưu là đúng, trả luôn.
  //   - Combo bị ảnh hưởng: tính từ các món của nó, gọi `resolve` cho từng món để combo con (cũng bị
  //     ảnh hưởng) được tính trước. Sau đó ghi kết quả vào `costs` và bỏ combo khỏi `affected`: lần
  //     sau, combo khác chứa nó sẽ đọc số mới từ `costs` thay vì tính lại, nên mỗi combo chỉ được
  //     tính đúng một lần, bất kể duyệt theo thứ tự nào.
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
    await tx.productItem.update({ where: { id }, data: { costPrice: cost } });
  }
}

/** `comboComponents` chỉ thuộc về COMBO: COMBO cần ít nhất một món, loại khác không được có (danh sách rỗng trên loại khác nghĩa là không có thành phần nên vẫn hợp lệ). */
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
