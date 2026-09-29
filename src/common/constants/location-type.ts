/**
 * A location's type - one constant and one spelling for the database and the API alike (plan
 * 2026-09-29). Uppercase because `Location.type` stores it that way, held to exactly these two
 * by the CHECK `locations_type_known`: the backend follows the schema rather than translating
 * it, and the frontend follows the backend. It replaced a lowercase API spelling that sat
 * beside a separate uppercase `LocationKind` - two names for one thing.
 */
export const LocationType = {
  BRANCH: 'BRANCH',
  WAREHOUSE: 'WAREHOUSE',
} as const;

export type LocationType = (typeof LocationType)[keyof typeof LocationType];

export const LOCATION_TYPES: readonly string[] = Object.values(LocationType);

/**
 * Directions that make a transfer a RETURN rather than an EXPORT. Only branch → warehouse:
 * whether sending goods to any other kind of place counts as a return is a business decision
 * nobody has made (plan 2026-09-29, QĐ-1). The label is all this decides - EXPORT and RETURN
 * move stock identically.
 */
const RETURN_DIRECTIONS: ReadonlyArray<readonly [string, string]> = [
  [LocationType.BRANCH, LocationType.WAREHOUSE],
];

export function isReturnDirection(fromType: string, toType: string): boolean {
  return RETURN_DIRECTIONS.some(
    ([from, to]) => from === fromType && to === toType,
  );
}
