/** Loại địa điểm dùng chung cho DB và API. */
export const LocationType = {
  BRANCH: 'BRANCH',
  WAREHOUSE: 'WAREHOUSE',
} as const;

export type LocationType = (typeof LocationType)[keyof typeof LocationType];

export const LOCATION_TYPES: readonly string[] = Object.values(LocationType);

/** Chỉ chi nhánh → kho tính là trả hàng, các chiều khác là xuất. */
const RETURN_DIRECTIONS: ReadonlyArray<readonly [string, string]> = [
  [LocationType.BRANCH, LocationType.WAREHOUSE],
];

export function isReturnDirection(fromType: string, toType: string): boolean {
  return RETURN_DIRECTIONS.some(
    ([from, to]) => from === fromType && to === toType,
  );
}
