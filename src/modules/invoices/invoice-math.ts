// Pure rules for what goes on an invoice, kept apart from the service so they can be unit-tested
// without a database (same shape as pricing-engine.ts).

export interface InvoiceableLine {
  quantity: number;
  returnedQuantity: number;
  lineTotal: number;
  unitPrice: number;
}

/** What a returned quantity of a line is worth: its share of the line total, so a line discount follows the goods back. */
export function returnedValue(line: {
  quantity: number;
  lineTotal: number;
  returned: number;
}): number {
  if (line.quantity <= 0 || line.returned <= 0) return 0;
  return Math.round((line.lineTotal * line.returned) / line.quantity);
}

/**
 * The lines of a SALE invoice. Goods that came back before the invoice was issued (a partial return
 * while the order was still on its way) are netted out here rather than invoiced and then adjusted.
 */
export function saleLines<T extends InvoiceableLine>(lines: T[]) {
  return lines
    .map((line) => {
      const quantity = line.quantity - line.returnedQuantity;
      const amount =
        line.lineTotal -
        returnedValue({
          quantity: line.quantity,
          lineTotal: line.lineTotal,
          returned: line.returnedQuantity,
        });
      return { line, quantity, amount };
    })
    .filter(({ quantity }) => quantity > 0);
}

/** Total of a SALE invoice: the order's total minus what already came back (shipping is not refunded by a goods return). */
export function saleTotal(
  grandTotal: number,
  lines: InvoiceableLine[],
): number {
  const returned = lines.reduce(
    (sum, line) =>
      sum +
      returnedValue({
        quantity: line.quantity,
        lineTotal: line.lineTotal,
        returned: line.returnedQuantity,
      }),
    0,
  );
  return Math.max(0, grandTotal - returned);
}

/** The next number in a per-shop sequence, from the highest existing one: `HD000041` -> `HD000042`. */
export function nextInvoiceNumber(prefix: string, highest: number): string {
  return `${prefix}${String(highest + 1).padStart(6, '0')}`;
}
