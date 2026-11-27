import { generateReference } from '../../common/utils/reference-generator';

// SKU của hàng làm riêng: SKU (hoặc mã hàng) gốc + "-C" + 6 ký tự hex. Dòng đơn không lưu SKU gốc, nên đây là cách
// duy nhất để biết một SKU riêng làm từ mặt hàng nào (xuất đơn ra file nhập cần nó). Sinh và đọc ngược ở cùng một chỗ.

const CUSTOM_SKU_BYTES = 3;
const CUSTOM_SKU_PATTERN = new RegExp(
  `^(.+)-C[0-9A-F]{${CUSTOM_SKU_BYTES * 2}}$`,
);

/** SKU (đồng thời là mã hàng) mới cho hàng làm riêng từ `base`. */
export function customSkuOf(base: string): string {
  return generateReference(`${base}-C`, CUSTOM_SKU_BYTES);
}

/** SKU gốc của một SKU làm riêng; null nếu `sku` không có dạng đó. */
export function baseSkuOfCustom(sku: string): string | null {
  return CUSTOM_SKU_PATTERN.exec(sku)?.[1] ?? null;
}
