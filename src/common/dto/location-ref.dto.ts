import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsUUID,
  ValidateIf,
} from 'class-validator';
import { LocationType, LOCATION_TYPES } from '../constants/location-type';

/** A "branch or warehouse" reference in the shape the API speaks; this file is the only place that maps it to the `branch_id`/`warehouse_id` FK pair. */
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

/** The pair of nullable FKs as Prisma writes them. Exactly one is ever set. */
export interface LocationColumns {
  branchId: string | null;
  warehouseId: string | null;
}

/** Nested request shape -> flat columns, for a write. */
export function toLocationColumns(ref: LocationRefDto): LocationColumns {
  return ref.locationType === LocationType.BRANCH
    ? { branchId: ref.locationId, warehouseId: null }
    : { branchId: null, warehouseId: ref.locationId };
}

/** Flat columns -> the API's pair. Null when the row somehow names neither. */
export function toLocationRef(row: {
  branchId: string | null;
  warehouseId: string | null;
}): { locationId: string; locationType: LocationType } | null {
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

/** The same reference as a Prisma `where` fragment - spread it into a filter; it narrows by location, by kind, or not at all. */
export function locationWhere(query: LocationRefQueryDto): {
  branchId?: string | { not: null };
  warehouseId?: string | { not: null };
} {
  const { locationId, locationType } = query;
  if (locationId) {
    // locationType is guaranteed present here by LocationRefQueryDto's validation.
    return locationType === LocationType.WAREHOUSE
      ? { warehouseId: locationId }
      : { branchId: locationId };
  }
  if (locationType === LocationType.BRANCH) return { branchId: { not: null } };
  if (locationType === LocationType.WAREHOUSE) {
    return { warehouseId: { not: null } };
  }
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

/** The same pair under StockMovementRequest's `from`/`to` prefixes, so call sites never spell out the four columns. */
export function toSourceColumns(ref: LocationRefDto): {
  fromBranchId: string | null;
  fromWarehouseId: string | null;
} {
  const { branchId, warehouseId } = toLocationColumns(ref);
  return { fromBranchId: branchId, fromWarehouseId: warehouseId };
}

export function toDestinationColumns(ref: LocationRefDto): {
  toBranchId: string | null;
  toWarehouseId: string | null;
} {
  const { branchId, warehouseId } = toLocationColumns(ref);
  return { toBranchId: branchId, toWarehouseId: warehouseId };
}

export function sourceRef(row: {
  fromBranchId: string | null;
  fromWarehouseId: string | null;
}) {
  return toLocationRef({
    branchId: row.fromBranchId,
    warehouseId: row.fromWarehouseId,
  });
}

export function destinationRef(row: {
  toBranchId: string | null;
  toWarehouseId: string | null;
}) {
  return toLocationRef({
    branchId: row.toBranchId,
    warehouseId: row.toWarehouseId,
  });
}
