// Quy tắc thuần cho nội dung hoá đơn, tách khỏi service để unit-test không cần DB (cùng kiểu với pricing-engine.ts).

export interface InvoiceableLine {
  quantity: number;
  returnedQuantity: number;
  lineTotal: number;
  unitPrice: number;
}

/** Giá trị số lượng trả lại của một dòng = phần tương ứng của thành tiền dòng, nên giảm giá theo dòng đi theo hàng trả. */
export function returnedValue(line: {
  quantity: number;
  lineTotal: number;
  returned: number;
}): number {
  if (line.quantity <= 0 || line.returned <= 0) return 0;
  return Math.round((line.lineTotal * line.returned) / line.quantity);
}

/**
 * Dòng của hoá đơn BÁN. Hàng trả về trước khi xuất hoá đơn (trả một phần khi đơn còn đang giao) được trừ luôn tại đây, không xuất rồi điều chỉnh sau.
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

/** Tổng hoá đơn BÁN: tổng đơn trừ phần hàng đã trả (phí ship không hoàn khi trả hàng). */
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

export function nextInvoiceNumber(prefix: string, highest: number): string {
  return `${prefix}${String(highest + 1).padStart(6, '0')}`;
}
