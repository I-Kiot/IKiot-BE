/**
 * Tiền trong bộ nhớ luôn là số nguyên đồng. Decimal của Prisma đổi ra số ở ranh giới đọc (`toDong`), và không so sánh `===` trên tổng các `Number(decimal)` lẻ: 0.1 + 0.2 !== 0.3 là chỗ lệch một đồng lọt vào sổ.
 * File thuần, không đọc DB, để mọi nơi (đơn, giao hàng, hoàn tiền, báo cáo) dùng chung một cách làm tròn.
 */

/** Mọi thứ đọc ra từ cột tiền: Decimal của Prisma có `toNumber`, hoặc số, chuỗi, null. */
export type MoneyLike =
  number | string | { toNumber(): number } | null | undefined;

/** Làm tròn về số nguyên đồng. null / undefined / không phải số là 0. */
export function toDong(value: MoneyLike): number {
  if (value === null || value === undefined) return 0;
  const n =
    typeof value === 'object'
      ? value.toNumber()
      : typeof value === 'string'
        ? Number(value)
        : value;
  return Number.isFinite(n) ? Math.round(n) : 0;
}

/** Tổng các khoản, mỗi khoản làm tròn trước khi cộng. */
export function sumDong(values: readonly MoneyLike[]): number {
  return values.reduce<number>((total, value) => total + toDong(value), 0);
}

/**
 * Chia `total` theo tỉ lệ `weights` bằng phương pháp phần dư lớn nhất: các phần cộng lại đúng bằng `total`, không lệch một đồng nào.
 * Phần dư bằng nhau thì phần đứng trước được cộng trước (ổn định). Tổng trọng số bằng 0 thì mọi phần là 0.
 */
export function allocateProportional(
  total: number,
  weights: readonly number[],
): number[] {
  if (weights.length === 0) return [];
  const sum = weights.reduce((a, b) => a + b, 0);
  const whole = Math.round(total);
  if (sum <= 0 || whole === 0) return weights.map(() => 0);

  const exact = weights.map((w) => (whole * w) / sum);
  const parts = exact.map((x) => Math.floor(x));
  let remainder = whole - parts.reduce((a, b) => a + b, 0);
  const order = exact
    .map((x, index) => ({ index, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.index - b.index);
  for (const { index } of order) {
    if (remainder <= 0) break;
    parts[index] += 1;
    remainder -= 1;
  }
  return parts;
}

/**
 * Phần giá trị của `returning` đơn vị khi dòng đã trả `alreadyReturned` đơn vị: chênh lệch của phân bổ luỹ kế, nên các lần trả cộng lại đúng bằng giá trị dòng và không trôi từng lần.
 * `lineNet` là giá trị thực của cả dòng (sau giảm giá), `lineQty` là số lượng cả dòng.
 */
export function sliceValue(
  lineNet: number,
  lineQty: number,
  alreadyReturned: number,
  returning: number,
): number {
  if (lineQty <= 0) return 0;
  const alloc = (qty: number) => Math.round((lineNet * qty) / lineQty);
  const before = Math.min(lineQty, alreadyReturned);
  const upTo = Math.min(lineQty, alreadyReturned + returning);
  return alloc(upTo) - alloc(before);
}
