/** Tiện ích tiền: luôn tính bằng số nguyên đồng. */

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

/** Chia `total` theo tỉ lệ `weights`, tổng các phần đúng bằng `total`. */
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

/** Giá trị của phần hàng trả, tính luỹ kế để các lần trả cộng đúng bằng giá trị dòng. */
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
