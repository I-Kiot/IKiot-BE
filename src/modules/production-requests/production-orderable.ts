import { rowKey, type ProductionState } from './production-list';
import { remainingNeedOf } from './production-request-rules';

// "Còn đặt xưởng được bao nhiêu cho một dòng đơn" - một phép tính cho nút "Tạo YCSX" (đọc đơn) và cho guard đặt vượt
// (`assertWithinOrderShortage`), nên hai nơi không thể lệch nhau. Hàm thuần: nhận `ProductionState` đã tải.
//
//   orderable(dòng) = min(phần còn cần của chính dòng, số thiếu của dòng chung (địa điểm, SKU))

export interface OrderableLineInput {
  id: string;
  productItemId: string;
  sourceLocationId: string | null;
  quantity: number;
  isCustom: boolean;
}

/** YCSX đang đặt chung cho (địa điểm, SKU) của dòng, còn chờ hàng. */
export interface PooledRequestRef {
  id: string;
  code: string;
  status: string;
  openQuantity: number;
}

export interface OrderableLine {
  orderItemId: string;
  /** Phần dòng còn cần (`remainingNeedOf`); null = không biết. */
  need: number | null;
  /** Phần của dòng đã có YCSX gắn riêng (cùng địa điểm + SKU) đứng ra nhận. */
  covered: number;
  /** Khoá dòng chung của danh sách sản xuất (`rowKey`). */
  poolKey: string;
  poolShort: number;
  /** null = không biết (dòng không nằm trong nhu cầu, hoặc dòng chuẩn không có stockCheck): guard bỏ qua. */
  orderable: number | null;
  coveringRequests: PooledRequestRef[];
}

export function orderableLinesOf(
  lines: readonly OrderableLineInput[],
  shortOf: (orderItemId: string) => number | null,
  state: ProductionState,
): Map<string, OrderableLine> {
  const entryByKey = new Map(state.entries.map((entry) => [entry.key, entry]));
  const result = new Map<string, OrderableLine>();
  for (const line of lines) {
    const cov = state.coverage.get(line.id);
    const poolKey = rowKey(
      line.sourceLocationId,
      line.productItemId,
      line.isCustom ? line.id : null,
    );
    const entry = entryByKey.get(poolKey);
    const poolShort = entry?.shortQuantity ?? 0;
    const need = remainingNeedOf(line, shortOf(line.id));
    const covered = cov?.coveredQuantity ?? 0;
    const orderable =
      !cov || need === null
        ? null
        : Math.max(0, Math.min(need - covered, poolShort));

    const covering = new Map<string, PooledRequestRef>();
    for (const request of entry?.requests ?? []) {
      if (request.outstanding <= 0) continue;
      const known = covering.get(request.requestId);
      if (known) known.openQuantity += request.outstanding;
      else {
        covering.set(request.requestId, {
          id: request.requestId,
          code: request.code,
          status: request.status,
          openQuantity: request.outstanding,
        });
      }
    }
    result.set(line.id, {
      orderItemId: line.id,
      need,
      covered,
      poolKey,
      poolShort,
      orderable,
      coveringRequests: [...covering.values()],
    });
  }
  return result;
}
