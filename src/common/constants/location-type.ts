/** Which kind of location a polymorphic reference points at; lowercase because that is what the API puts on the wire. */
export const LocationType = {
  BRANCH: 'branch',
  WAREHOUSE: 'warehouse',
} as const;

export type LocationType = (typeof LocationType)[keyof typeof LocationType];

export const LOCATION_TYPES: readonly string[] = Object.values(LocationType);

/** `Location.type` as the database stores it - the API's type, uppercased. Held to exactly these two by the CHECK `locations_type_known`. */
export const LocationKind = {
  BRANCH: 'BRANCH',
  WAREHOUSE: 'WAREHOUSE',
} as const;

export type LocationKind = (typeof LocationKind)[keyof typeof LocationKind];

/** API type -> DB kind. */
export function locationKindOf(type: string): LocationKind {
  return type === LocationType.WAREHOUSE
    ? LocationKind.WAREHOUSE
    : LocationKind.BRANCH;
}
