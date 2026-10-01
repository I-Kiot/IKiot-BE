import { NotFoundException } from '@nestjs/common';
import { IsIn, IsOptional, IsUUID } from 'class-validator';
import { LocationType, LOCATION_TYPES } from '../constants/location-type';
import { ErrorCode } from '../errors/error-codes';
import type { Prisma } from '../../../generated/prisma/client';

// The one place that knows how a location is referenced. A Branch or Warehouse shares its id
// with the Location it specializes (CHECK constraints in migration
// 20260929065032_refactor_location_schema), so a `locationId` on the API is all three at once.

/**
 * A location filter on the stock reads (`GET /inventory`, `GET /products`, `GET /products/:id`).
 * The two fields are independent - one location, one kind of location, both, or neither -
 * because the id alone already names the Location, so it no longer needs its kind beside it.
 * `locationType` is the schema's own value (`BRANCH` / `WAREHOUSE`).
 */
export class LocationRefQueryDto {
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @IsIn(LOCATION_TYPES, {
    message: `locationType phải là ${LOCATION_TYPES.join(' hoặc ')}`,
  })
  locationType?: string;
}

/** The one shape a location takes in a stock response, as an include fragment: `location: LOCATION_SELECT`. */
export const LOCATION_SELECT = {
  select: { id: true, type: true, name: true },
} as const satisfies Prisma.LocationDefaultArgs;

export type LocationRef = Prisma.LocationGetPayload<typeof LOCATION_SELECT>;

/** A location named by the client on a stock write. Only the id: its kind lives on the row, so asking the client for it too would be a second answer that could disagree (coding rule 4). */
export class LocationIdDto {
  @IsUUID()
  locationId: string;
}

/** Anything that can read locations - `this.prisma` or a transaction client alike (coding rule 16). */
type LocationReader = Pick<Prisma.TransactionClient, 'location'>;

/** One end of a stock operation, as the rules need it: which location, and what kind. */
export interface LocationEnd {
  id: string;
  type: string;
}

/**
 * Every location a request names must exist inside the caller's tenant: the FK would catch a
 * made-up id but knows nothing about tenants. One query however many ids (coding rule 19),
 * after de-duplicating, so a movement naming the same place twice reaches the SAME_LOCATION
 * rule instead of failing here as "not found". Status is deliberately not checked - a
 * soft-deleted location still resolves, as it did before the refactor (plan 2026-09-29, QĐ-2).
 */
export async function resolveLocations(
  db: LocationReader,
  tenantId: string,
  ids: (string | null | undefined)[],
): Promise<Map<string, LocationEnd>> {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))];
  if (wanted.length === 0) return new Map();

  const rows = await db.location.findMany({
    where: { tenantId, id: { in: wanted } },
    select: { id: true, type: true },
  });
  if (rows.length !== wanted.length) {
    throw new NotFoundException({
      code: ErrorCode.LOCATION_NOT_FOUND,
      message: 'Location not found',
    });
  }
  return new Map(rows.map((row) => [row.id, row]));
}

/** A location reference held in memory as the API thinks of it - exactly one side is ever set. Services reason in this shape; the database stores a single `location_id` plus the Location's `type`. */
export interface LocationColumns {
  branchId: string | null;
  warehouseId: string | null;
}

/** Include/select fragment for a `location` relation that brings back what {@link columnsOfLocation} needs. */
export const LOCATION_TYPE_SELECT = {
  select: { id: true, type: true },
} as const;

/** The `location` relation as loaded with {@link LOCATION_TYPE_SELECT}. */
export interface LocationTypeRow {
  id: string;
  type: string;
}

/** A loaded `location` relation -> in-memory pair. */
export function columnsOfLocation(
  location: LocationTypeRow | null | undefined,
): LocationColumns {
  if (location?.type === LocationType.BRANCH) {
    return { branchId: location.id, warehouseId: null };
  }
  if (location?.type === LocationType.WAREHOUSE) {
    return { branchId: null, warehouseId: location.id };
  }
  return { branchId: null, warehouseId: null };
}

/** In-memory pair -> the `{ locationId, locationType }` reference `stats` still answers with. Null when it names neither. */
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
export function locationRefOf(location: LocationTypeRow | null | undefined) {
  return toLocationRef(columnsOfLocation(location));
}

/** A {@link LocationRefQueryDto} as a Prisma `where` fragment over a model with a `location` relation - spread it into a filter; it narrows by location, by kind, both, or not at all. */
export function locationWhere(
  query: LocationRefQueryDto,
): Pick<Prisma.InventoryWhereInput, 'locationId' | 'location'> {
  const where: Pick<Prisma.InventoryWhereInput, 'locationId' | 'location'> = {};
  if (query.locationId) where.locationId = query.locationId;
  if (query.locationType) where.location = { type: query.locationType };
  return where;
}

/**
 * The same narrowing as `locationWhere`, but as a predicate over rows already in memory.
 *
 * Reads that report "stock here" *and* "stock across the chain" load every location's rows
 * in one query and split them afterwards, so the split has to follow exactly the rule the
 * `where` fragment above would have applied - which is why it lives next to it rather than
 * being spelled out at the call site. A row must carry `locationId` *and* `location.type`:
 * selecting only one of them would make the "here" figure silently 0.
 */
export function locationMatcher(
  query: LocationRefQueryDto,
): (row: { locationId: string; location: { type: string } }) => boolean {
  return (row) =>
    (!query.locationId || row.locationId === query.locationId) &&
    (!query.locationType || row.location.type === query.locationType);
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
export const USER_POSTING_SELECT = { location: LOCATION_TYPE_SELECT } as const;

/** A row loaded with {@link USER_POSTING_SELECT} -> the same row carrying `branchId`/`warehouseId` again, so scope checks written against that pair keep working. */
export function withPosting<T extends { location: LocationTypeRow | null }>(
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

/** Like {@link withPosting}, but for responses that also embed the workplace itself as `branch` / `warehouse` (id, name, ...) - the shape the staff screens have always read. Select `location: { select: { id, type, ...whatever to embed } }`. */
export function withNamedPosting<
  T extends { location: LocationTypeRow | null },
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
