/** Which kind of location a polymorphic reference points at; lowercase because that is what the API puts on the wire. */
export const LocationType = {
  BRANCH: 'branch',
  WAREHOUSE: 'warehouse',
} as const;

export type LocationType = (typeof LocationType)[keyof typeof LocationType];

export const LOCATION_TYPES: readonly string[] = Object.values(LocationType);
