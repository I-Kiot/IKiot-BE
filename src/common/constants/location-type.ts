/**
 * Loại địa điểm, một cách viết cho cả DB lẫn API. CHECK `locations_type_known` ép đúng hai giá trị này, nên backend theo schema và frontend theo backend. Không đặt thêm tên khác cho cùng khái niệm.
 */
export const LocationType = {
  BRANCH: 'BRANCH',
  WAREHOUSE: 'WAREHOUSE',
} as const;

export type LocationType = (typeof LocationType)[keyof typeof LocationType];

export const LOCATION_TYPES: readonly string[] = Object.values(LocationType);

/**
 * Chỉ chi nhánh → kho được tính là TRẢ HÀNG thay vì XUẤT; các chiều khác chưa có quyết định nghiệp vụ (QĐ-1). Nhãn là thứ duy nhất nó quyết định, còn kho đều di chuyển như nhau.
 */
const RETURN_DIRECTIONS: ReadonlyArray<readonly [string, string]> = [
  [LocationType.BRANCH, LocationType.WAREHOUSE],
];

export function isReturnDirection(fromType: string, toType: string): boolean {
  return RETURN_DIRECTIONS.some(
    ([from, to]) => from === fromType && to === toType,
  );
}
