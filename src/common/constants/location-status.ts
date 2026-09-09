/** Branch/Warehouse lifecycle. DELETED is a soft delete, reachable only through the DELETE route. */
export const LocationStatus = {
  ACTIVE: 'ACTIVE',
  INACTIVE: 'INACTIVE',
  DELETED: 'DELETED',
} as const;

export type LocationStatus =
  (typeof LocationStatus)[keyof typeof LocationStatus];

/** What a client may set directly. */
export const SETTABLE_LOCATION_STATUSES: readonly string[] = [
  LocationStatus.ACTIVE,
  LocationStatus.INACTIVE,
];

/** What a list endpoint may be filtered by. */
export const FILTERABLE_LOCATION_STATUSES: readonly string[] = [
  LocationStatus.ACTIVE,
  LocationStatus.INACTIVE,
  LocationStatus.DELETED,
];
