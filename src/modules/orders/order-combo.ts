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

export type ComboGraphReader = Pick<Prisma.TransactionClient, 'comboComponent'>;

/**
 * Đồ thị combo dưới `comboIds`: với mỗi combo tới được, các thành phần trực tiếp. Nạp mỗi tầng một query, mỗi tầng bị chặn bởi `MAX_COMBO_DEPTH`. Phía đơn (mở combo thành dòng) và phía danh mục (đếm số bộ trên kệ) dùng chung, nên hai bên phải duyệt giống hệt nhau.
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
    // Combo con đã nạp (hoặc vòng quay lại combo đó) không nạp lại; `flattenCombo` là nơi báo lỗi vòng.
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
 * Dòng đơn dưới dạng hàng: mỗi dòng có giá; dưới mỗi dòng COMBO là một dòng con cho từng lá đã phẳng hóa, giá 0.
 * Tiền nằm ở dòng combo, còn con mang tồn kho và xuất từ kho của combo. Con là COMBO_COMPONENT, hoặc SERVICE nếu lá là dịch vụ
 * (dịch vụ không cần hàng nên không có kho xuất).
 *
 * `sourceLocationId` có thể null ở mọi dòng: quầy (`OrderService.createPosSale`) trừ kho ngay tại chi nhánh và chưa bao giờ lưu kho xuất.
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
      // Dòng COMBO chỉ có giá nên không có kho để tìm; con của nó thì có.
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
