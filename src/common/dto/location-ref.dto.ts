import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsUUID,
  ValidateIf,
} from 'class-validator';
import {
  LocationKind,
  LocationType,
  LOCATION_TYPES,
  locationKindOf,
} from '../constants/location-type';

/** A "branch or warehouse" reference in the shape the API speaks; this file is the only place that maps it to `Location` rows. The API's `locationId` is the Location id itself: a Branch or Warehouse always shares its id with the Location it specializes (CHECK constraints in migration 20260929065032_refactor_location_schema). */
export class LocationRefDto {
  @IsUUID()
  @IsNotEmpty({ message: 'Thiếu địa điểm' })
  locationId: string;

  @IsIn(LOCATION_TYPES, {
    message: `locationType phải là ${LOCATION_TYPES.join(' hoặc ')}`,
  })
  locationType: string;
}

/** The same reference as a filter: both fields may be absent, but a location id without its type never resolves. */
export class LocationRefQueryDto {
  @IsOptional()
  @IsUUID()
  locationId?: string;

  // Not @IsOptional(): once either field is present, locationType has to be a real value.
  @ValidateIf(
    (q: LocationRefQueryDto) =>
      q.locationId !== undefined || q.locationType !== undefined,
  )
  @IsIn(LOCATION_TYPES, {
    message: `locationType phải là ${LOCATION_TYPES.join(' hoặc ')} (bắt buộc khi có locationId)`,
  })
  locationType?: string;
}

/** A location reference held in memory as the API thinks of it - exactly one side is ever set. Services reason in this shape; the database stores a single `location_id` plus the Location's `type`. */
export interface LocationColumns {
  branchId: string | null;
  warehouseId: string | null;
}

/** Include/select fragment for a `location` relation that brings back what {@link columnsOfLocation} needs. */
export const LOCATION_KIND_SELECT = {
  select: { id: true, type: true },
} as const;

/** The `location` relation as loaded with {@link LOCATION_KIND_SELECT}. */
export interface LocationKindRow {
  id: string;
  type: string;
}

/** Nested request shape -> in-memory pair. */
export function toLocationColumns(ref: LocationRefDto): LocationColumns {
  return ref.locationType === LocationType.BRANCH
    ? { branchId: ref.locationId, warehouseId: null }
    : { branchId: null, warehouseId: ref.locationId };
}

/** A loaded `location` relation -> in-memory pair. */
export function columnsOfLocation(
  location: LocationKindRow | null | undefined,
): LocationColumns {
  if (location?.type === LocationKind.BRANCH) {
    return { branchId: location.id, warehouseId: null };
  }
  if (location?.type === LocationKind.WAREHOUSE) {
    return { branchId: null, warehouseId: location.id };
  }
  return { branchId: null, warehouseId: null };
}

/** In-memory pair -> the single `location_id` column. */
export function locationIdOf(columns: LocationColumns): string | null {
  return columns.branchId ?? columns.warehouseId;
}

/** In-memory pair -> the API's reference. Null when it names neither. */
export function toLocationRef(
  row: LocationColumns,
): { locationId: string; locationType: LocationType } | null {
  if (row.branchId) {
    return { locationId: row.branchId, locationType: LocationType.BRANCH };
  }
  if (row.warehouseId) {
    return {
      locationId: row.warehouseId,
      locationType: LocationType.WAREHOUSE,
    };
  }
  return null;
}

/** A loaded `location` relation straight to the API's reference. */
export function locationRefOf(location: LocationKindRow | null | undefined) {
  return toLocationRef(columnsOfLocation(location));
}

/** The same reference as a Prisma `where` fragment over a model with a `location` relation - spread it into a filter; it narrows by location, by kind, or not at all. */
export function locationWhere(query: LocationRefQueryDto): {
  locationId?: string;
  location?: { type: LocationKind };
} {
  const { locationId, locationType } = query;
  if (locationId) {
    // locationType is guaranteed present here by LocationRefQueryDto's validation.
    return {
      locationId,
      location: { type: locationKindOf(locationType ?? LocationType.BRANCH) },
    };
  }
  if (locationType) return { location: { type: locationKindOf(locationType) } };
  return {};
}

/**
 * The same narrowing as `locationWhere`, but as a predicate over rows already in memory.
 *
 * Reads that report "stock here" *and* "stock across the chain" load every location's rows
 * in one query and split them afterwards, so the split has to follow exactly the rule the
 * `where` fragment above would have applied - which is why it lives next to it rather than
 * being spelled out at the call site.
 */
export function locationMatcher(
  query: LocationRefQueryDto,
): (row: LocationColumns) => boolean {
  const { locationId, locationType } = query;
  if (locationId) {
    // locationType is guaranteed present here by LocationRefQueryDto's validation.
    return locationType === LocationType.WAREHOUSE
      ? (row) => row.warehouseId === locationId
      : (row) => row.branchId === locationId;
  }
  if (locationType === LocationType.BRANCH)
    return (row) => row.branchId !== null;
  if (locationType === LocationType.WAREHOUSE) {
    return (row) => row.warehouseId !== null;
  }
  return () => true;
}

/** Select fragment for a `branch` relation whose name the response shows - the name lives on the Location now, not the Branch. Pair with {@link namedBranch}. */
export const BRANCH_NAME_SELECT = {
  select: { id: true, location: { select: { name: true } } },
} as const;

/** `{ id, location: { name } }` -> the `{ id, name }` the API has always answered with. */
export function namedBranch(
  branch: { id: string; location: { name: string } } | null | undefined,
): { id: string; name: string } | null {
  return branch ? { id: branch.id, name: branch.location.name } : null;
}

/** Spread into a User `select`/`include` wherever the old code read `branchId`/`warehouseId` off the user. Pair with {@link withPosting}. */
export const USER_POSTING_SELECT = { location: LOCATION_KIND_SELECT } as const;

/** A row loaded with {@link USER_POSTING_SELECT} -> the same row carrying `branchId`/`warehouseId` again, so scope checks written against that pair keep working. */
export function withPosting<T extends { location: LocationKindRow | null }>(
  row: T,
): Omit<T, 'location'> & LocationColumns {
  const { location, ...rest } = row;
  return { ...rest, ...columnsOfLocation(location) };
}

/** A `{ branchId?, warehouseId? }` scope as a filter on a model's single `locationId` column. Naming both still matches nothing, as the old AND over two columns did. */
export function postingWhere(scope: {
  branchId?: string | null;
  warehouseId?: string | null;
}): { AND?: { locationId: string }[] } {
  const ids = [scope.branchId, scope.warehouseId].filter((id): id is string =>
    Boolean(id),
  );
  return ids.length > 0
    ? { AND: ids.map((locationId) => ({ locationId })) }
    : {};
}

/** Like {@link withPosting}, but for responses that also embed the workplace itself as `branch` / `warehouse` (id, name, ...) - the shape the staff, leave and attendance screens have always read. Select `location: { select: { id, type, ...whatever to embed } }`. */
export function withNamedPosting<
  T extends { location: LocationKindRow | null },
>(
  row: T,
): Omit<T, 'location'> &
  LocationColumns & {
    branch: Omit<NonNullable<T['location']>, 'type'> | null;
    warehouse: Omit<NonNullable<T['location']>, 'type'> | null;
  } {
  const { location, ...rest } = row;
  const columns = columnsOfLocation(location);
  let place: Omit<NonNullable<T['location']>, 'type'> | null = null;
  if (location) {
    const { type, ...fields } = location as NonNullable<T['location']>;
    place = fields;
  }
  return {
    ...rest,
    ...columns,
    branch: columns.branchId ? place : null,
    warehouse: columns.warehouseId ? place : null,
  };
}

/** {@link locationIdOf} for a place that must be named - a stock read at "no location" would otherwise become a filter that is silently dropped. */
export function requireLocationId(columns: LocationColumns): string {
  const id = locationIdOf(columns);
  if (!id)
    throw new Error(
      'Location reference names neither a branch nor a warehouse',
    );
  return id;
}
