/**
 * Luật phân bổ lô cho InventoryService, để thuần nên test không cần DB. Service nạp (và khoá) dòng, hỏi các hàm
 * này cần làm gì rồi ghi kết quả, không theo chiều ngược lại.
 */

export interface LotSlice {
  lotId: string;
  quantity: number;
}

export interface DrawableLot {
  id: string;
  remainingQuantity: number;
  receivedAt: Date;
  /** Chỉ đặt trên lô làm riêng cho một dòng đơn tuỳ chỉnh. */
  orderItemId: string | null;
}

/**
 * Lô nào bị trừ cho `quantity`: lô làm riêng cho `forOrderItemId` trước, rồi lô dùng chung cũ nhất (FIFO theo `receivedAt`).
 * Lô làm cho dòng khác không bao giờ bị chạm. `null` khi đủ điều kiện không đủ số lượng (lỗi dữ liệu: tồn đã báo có).
 */
export function planDraw(
  lots: readonly DrawableLot[],
  quantity: number,
  forOrderItemId?: string | null,
): LotSlice[] | null {
  const own = forOrderItemId
    ? lots.filter((lot) => lot.orderItemId === forOrderItemId)
    : [];
  const shared = lots
    .filter((lot) => lot.orderItemId === null)
    .sort(
      (a, b) =>
        a.receivedAt.getTime() - b.receivedAt.getTime() ||
        a.id.localeCompare(b.id),
    );

  const slices: LotSlice[] = [];
  let left = quantity;
  for (const lot of [...own, ...shared]) {
    if (left <= 0) break;
    const take = Math.min(left, lot.remainingQuantity);
    if (take <= 0) continue;
    slices.push({ lotId: lot.id, quantity: take });
    left -= take;
  }
  return left > 0 ? null : slices;
}

export interface DrawnLot {
  lotId: string;
  /** Số đơn vị chứng từ này đã lấy khỏi lô. */
  drawn: number;
  /** Số đơn vị đã trả lại theo cùng chứng từ. */
  returned: number;
}

/**
 * Chia `quantity` đơn vị trả về vào các lô chứng từ đó đã lấy, để mỗi đơn vị về đúng lô đã rời.
 * `null` nếu trả nhiều hơn đã xuất.
 */
export function planReturn(
  lots: readonly DrawnLot[],
  quantity: number,
): LotSlice[] | null {
  const slices: LotSlice[] = [];
  let left = quantity;
  for (const lot of lots) {
    if (left <= 0) break;
    const take = Math.min(left, lot.drawn - lot.returned);
    if (take <= 0) continue;
    slices.push({ lotId: lot.lotId, quantity: take });
    left -= take;
  }
  return left > 0 ? null : slices;
}

/** Mức tồn sau mỗi phần khi áp dụng, tính từ mức trước cả phiếu. Dòng sổ cái lưu ở `balanceAfter`. */
export function runningBalances(
  before: number,
  signedQuantities: readonly number[],
): number[] {
  let balance = before;
  return signedQuantities.map((quantity) => (balance += quantity));
}

/** Giá vốn bình quân các đơn vị dòng đã lấy: Σ(-quantity × unitCost) / Σ(-quantity) trên dòng SALE và SALE_REVERSAL. `null` khi không còn gì đã lấy. */
export function averageUnitCost(
  rows: readonly { quantity: number; unitCost: number }[],
): number | null {
  let units = 0;
  let cost = 0;
  for (const row of rows) {
    units -= row.quantity;
    cost -= row.quantity * row.unitCost;
  }
  return units > 0 ? Math.round((cost / units) * 100) / 100 : null;
}
