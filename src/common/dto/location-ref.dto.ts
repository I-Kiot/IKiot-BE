import { NotFoundException } from '@nestjs/common';
import { IsIn, IsOptional, IsUUID } from 'class-validator';
import { LocationType, LOCATION_TYPES } from '../constants/location-type';
import { ErrorCode } from '../errors/error-codes';
import type { Prisma } from '../../../generated/prisma/client';

// Cách tham chiếu địa điểm; Branch và Warehouse dùng chung id với Location.

/** Bộ lọc địa điểm cho API đọc tồn kho: theo id, theo loại, hoặc cả hai. */
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

/** Hình dạng địa điểm trong response tồn kho, dưới dạng include fragment: `location: LOCATION_SELECT`. */
export const LOCATION_SELECT = {
  select: { id: true, type: true, name: true },
} as const satisfies Prisma.LocationDefaultArgs;

export type LocationRef = Prisma.LocationGetPayload<typeof LOCATION_SELECT>;

/** Địa điểm client gửi khi ghi tồn kho, chỉ cần id. */
export class LocationIdDto {
  @IsUUID()
  locationId: string;
}

/** Thứ có thể đọc địa điểm - `this.prisma` hoặc transaction client đều được. */
type LocationReader = Pick<Prisma.TransactionClient, 'location'>;

/** Một đầu của thao tác kho, theo đúng những gì rule cần: địa điểm nào và loại gì. */
export interface LocationEnd {
  id: string;
  type: string;
}

/** Kiểm mọi địa điểm trong request thuộc tenant của người gọi. */
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

/** Tham chiếu địa điểm trong bộ nhớ, luôn chỉ một bên chi nhánh hoặc kho có giá trị. */
export interface LocationColumns {
  branchId: string | null;
  warehouseId: string | null;
}

/** Select fragment cho quan hệ `location`, đủ dữ liệu cho {@link columnsOfLocation}. */
export const LOCATION_TYPE_SELECT = {
  select: { id: true, type: true },
} as const;

/** Quan hệ `location` đã load bằng {@link LOCATION_TYPE_SELECT}. */
export interface LocationTypeRow {
  id: string;
  type: string;
}

/** Quan hệ `location` đã load -> cặp trong bộ nhớ. */
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

/** Đổi cặp chi nhánh/kho thành `{ locationId, locationType }`, null khi không có. */
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

/** Quan hệ `location` đã load, đi thẳng ra tham chiếu của API. */
export function locationRefOf(location: LocationTypeRow | null | undefined) {
  return toLocationRef(columnsOfLocation(location));
}

/** Đổi bộ lọc địa điểm thành `where` của Prisma. */
export function locationWhere(
  query: LocationRefQueryDto,
): Pick<Prisma.InventoryWhereInput, 'locationId' | 'location'> {
  const where: Pick<Prisma.InventoryWhereInput, 'locationId' | 'location'> = {};
  if (query.locationId) where.locationId = query.locationId;
  if (query.locationType) where.location = { type: query.locationType };
  return where;
}

/** Bộ lọc địa điểm trên dữ liệu đã tải, cùng quy tắc với `locationWhere`. */
export function locationMatcher(
  query: LocationRefQueryDto,
): (row: { locationId: string; location: { type: string } }) => boolean {
  return (row) =>
    (!query.locationId || row.locationId === query.locationId) &&
    (!query.locationType || row.location.type === query.locationType);
}

/** Select tên chi nhánh (tên nằm ở Location), dùng với `namedBranch`. */
export const BRANCH_NAME_SELECT = {
  select: { id: true, location: { select: { name: true } } },
} as const;

/** `{ id, location: { name } }` -> `{ id, name }` mà API vẫn trả về từ trước tới nay. */
export function namedBranch(
  branch: { id: string; location: { name: string } } | null | undefined,
): { id: string; name: string } | null {
  return branch ? { id: branch.id, name: branch.location.name } : null;
}

/** Select nơi làm việc của user để đọc lại `branchId`/`warehouseId`. */
export const USER_POSTING_SELECT = { location: LOCATION_TYPE_SELECT } as const;

/** Thêm lại `branchId`/`warehouseId` vào user đã tải. */
export function withPosting<T extends { location: LocationTypeRow | null }>(
  row: T,
): Omit<T, 'location'> & LocationColumns {
  const { location, ...rest } = row;
  return { ...rest, ...columnsOfLocation(location) };
}

/** Đổi phạm vi chi nhánh/kho thành bộ lọc trên `locationId`. */
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

/** Như `withPosting`, kèm thông tin nơi làm việc lồng trong `branch` / `warehouse`. */
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
