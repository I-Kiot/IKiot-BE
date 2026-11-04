import { NotFoundException } from '@nestjs/common';
import { IsIn, IsOptional, IsUUID } from 'class-validator';
import { LocationType, LOCATION_TYPES } from '../constants/location-type';
import { ErrorCode } from '../errors/error-codes';
import type { Prisma } from '../../../generated/prisma/client';

// Nơi duy nhất biết cách tham chiếu một địa điểm. Branch và Warehouse dùng chung id với Location
// mà chúng chuyên biệt hoá (CHECK trong migration 20260929065032_refactor_location_schema), nên
// `locationId` trên API là cả ba cùng lúc.

/**
 * Bộ lọc địa điểm cho API đọc tồn kho. `locationId` đã xác định Location nên không cần kèm loại; `locationType` là giá trị schema (`BRANCH` / `WAREHOUSE`). Hai trường độc lập.
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

/** Hình dạng địa điểm trong response tồn kho, dưới dạng include fragment: `location: LOCATION_SELECT`. */
export const LOCATION_SELECT = {
  select: { id: true, type: true, name: true },
} as const satisfies Prisma.LocationDefaultArgs;

export type LocationRef = Prisma.LocationGetPayload<typeof LOCATION_SELECT>;

/** Địa điểm client gửi khi ghi tồn kho. Chỉ gửi id: loại nằm sẵn trên dòng, hỏi thêm loại sẽ tạo đáp án thứ hai có thể lệch. */
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

/**
 * Mọi địa điểm request nêu phải nằm trong tenant của người gọi: FK bắt được id bịa nhưng không biết
 * tenant. Một truy vấn cho mọi id, sau khi khử trùng, nên phiếu chuyển cùng một nơi hai lần vẫn tới
 * rule SAME_LOCATION thay vì báo "không tìm thấy" ở đây. Cố ý không kiểm tra status: Location đã xoá
 * mềm vẫn resolve được, như trước refactor (kế hoạch 2026-09-29, QĐ-2).
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

/** Tham chiếu địa điểm trong bộ nhớ theo cách API nghĩ - luôn chỉ một bên có giá trị. Service suy luận theo dạng này; DB lưu một `location_id` cùng `type` của Location. */
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

/** Cặp trong bộ nhớ -> tham chiếu `{ locationId, locationType }` mà `stats` vẫn trả về. Null khi không gán gì. */
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

/** {@link LocationRefQueryDto} thành fragment `where` của Prisma trên model có quan hệ `location`; spread vào filter. Lọc theo địa điểm, theo loại, cả hai hoặc không. */
export function locationWhere(
  query: LocationRefQueryDto,
): Pick<Prisma.InventoryWhereInput, 'locationId' | 'location'> {
  const where: Pick<Prisma.InventoryWhereInput, 'locationId' | 'location'> = {};
  if (query.locationId) where.locationId = query.locationId;
  if (query.locationType) where.location = { type: query.locationType };
  return where;
}

/**
 * Cùng phép lọc như `locationWhere`, nhưng là predicate trên các dòng đã có trong bộ nhớ.
 *
 * Các đọc vừa báo "tồn tại đây" vừa báo "tồn toàn chuỗi" load dòng của mọi địa điểm trong một
 * truy vấn rồi tách sau, nên phép tách phải đúng quy tắc của fragment `where` ở trên - vì vậy nó
 * nằm cạnh đó thay vì viết tại chỗ gọi. Dòng phải có cả `locationId` *và* `location.type`: chỉ
 * chọn một trong hai thì số "tại đây" sẽ lặng lẽ thành 0.
 */
export function locationMatcher(
  query: LocationRefQueryDto,
): (row: { locationId: string; location: { type: string } }) => boolean {
  return (row) =>
    (!query.locationId || row.locationId === query.locationId) &&
    (!query.locationType || row.location.type === query.locationType);
}

/** Select fragment cho quan hệ `branch` mà response hiển thị tên - tên giờ nằm ở Location, không ở Branch. Dùng với {@link namedBranch}. */
export const BRANCH_NAME_SELECT = {
  select: { id: true, location: { select: { name: true } } },
} as const;

/** `{ id, location: { name } }` -> `{ id, name }` mà API vẫn trả về từ trước tới nay. */
export function namedBranch(
  branch: { id: string; location: { name: string } } | null | undefined,
): { id: string; name: string } | null {
  return branch ? { id: branch.id, name: branch.location.name } : null;
}

/** Spread vào `select`/`include` của User ở mọi chỗ code cũ đọc `branchId`/`warehouseId` từ user. Dùng với {@link withPosting}. */
export const USER_POSTING_SELECT = { location: LOCATION_TYPE_SELECT } as const;

/** Row load bằng {@link USER_POSTING_SELECT} -> cùng row, có lại `branchId`/`warehouseId`, để check scope viết theo cặp đó vẫn chạy. */
export function withPosting<T extends { location: LocationTypeRow | null }>(
  row: T,
): Omit<T, 'location'> & LocationColumns {
  const { location, ...rest } = row;
  return { ...rest, ...columnsOfLocation(location) };
}

/** Scope `{ branchId?, warehouseId? }` thành filter trên cột `locationId` duy nhất của model. Nêu cả hai vẫn không khớp gì, như AND trên hai cột cũ. */
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

/** Giống {@link withPosting}, nhưng cho response còn nhúng nơi làm việc dưới `branch` / `warehouse` (id, tên, ...) - hình dạng màn nhân viên vẫn đọc. Select `location: { select: { id, type, ...những gì cần nhúng } }`. */
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
