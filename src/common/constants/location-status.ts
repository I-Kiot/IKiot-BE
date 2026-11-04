/** Vòng đời Branch/Warehouse. DELETED là xoá mềm, chỉ qua route DELETE. */
export const LocationStatus = {
  ACTIVE: 'ACTIVE',
  INACTIVE: 'INACTIVE',
  DELETED: 'DELETED',
} as const;

export type LocationStatus =
  (typeof LocationStatus)[keyof typeof LocationStatus];

export const SETTABLE_LOCATION_STATUSES: readonly string[] = [
  LocationStatus.ACTIVE,
  LocationStatus.INACTIVE,
];

export const FILTERABLE_LOCATION_STATUSES: readonly string[] = [
  LocationStatus.ACTIVE,
  LocationStatus.INACTIVE,
  LocationStatus.DELETED,
];
