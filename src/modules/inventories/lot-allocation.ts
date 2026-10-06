/**
 * The allocation rules behind InventoryService's lot writes, kept pure so they
 * can be tested without a database. The service loads (and locks) the rows, asks these
 * functions what to do, and writes the answer - never the other way round.
 */

export interface LotSlice {
  lotId: string;
  quantity: number;
}

export interface DrawableLot {
  id: string;
  remainingQuantity: number;
  receivedAt: Date;
  /** Set only on a lot made for one custom order line. */
  orderItemId: string | null;
}

/**
 * Which lots an outbound move of `quantity` draws from: the lots made for `forOrderItemId`
 * first, then the shared lots oldest-first (FIFO by `receivedAt`, id as the tie-break so the
 * order is stable). A lot made for a *different* line is never touched. Returns `null` when
 * the eligible lots cannot cover the quantity - the caller treats that as a data fault, since
 * `inventories.stock` already said the goods were there.
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
  /** Units this document took out of the lot. */
  drawn: number;
  /** Units already brought back against the same document. */
  returned: number;
}

/**
 * How `quantity` units coming back against a document (a cancelled transfer, a packed sale
 * cancelled before hand-over, a customer return) split over the lots that document drew
 * from, so each unit returns to - or is split off from - the lot it left. Lots are used in
 * the order given. `null` when more is coming back than was taken out and not yet returned.
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

/** Each slice's running stock level after it is applied, given the level before the whole move. Ledger rows carry it as `balanceAfter`. */
export function runningBalances(
  before: number,
  signedQuantities: readonly number[],
): number[] {
  let balance = before;
  return signedQuantities.map((quantity) => (balance += quantity));
}

/** Average cost of the units a line has actually taken out: Σ(-quantity × unitCost) / Σ(-quantity) over its SALE and SALE_REVERSAL rows. `null` once nothing is out any more. */
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
