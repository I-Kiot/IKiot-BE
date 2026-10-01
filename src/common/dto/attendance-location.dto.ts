import { Type } from 'class-transformer';
import { IsInt, IsNumber, IsOptional, Max, Min } from 'class-validator';

/** The geofence a branch or warehouse takes attendance inside: stored flat in Postgres, exposed nested as iKiotMS-BE did. */
export class AttendanceLocationDto {
  @IsOptional()
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude?: number;

  @IsOptional()
  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  allowedRadiusMeters?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxAccuracyMeters?: number;
}

/** The four flattened columns as Prisma writes them. */
export interface AttendanceLocationColumns {
  attendanceLatitude?: number | null;
  attendanceLongitude?: number | null;
  attendanceAllowedRadiusMeters?: number | null;
  attendanceMaxAccuracyMeters?: number | null;
}

/** Nested request shape -> flat columns; `{}` when the caller omitted the object, so a PATCH leaves the geofence alone. */
export function toAttendanceColumns(
  location?: AttendanceLocationDto,
): AttendanceLocationColumns {
  if (!location) return {};
  return {
    attendanceLatitude: location.latitude,
    attendanceLongitude: location.longitude,
    attendanceAllowedRadiusMeters: location.allowedRadiusMeters,
    attendanceMaxAccuracyMeters: location.maxAccuracyMeters,
  };
}

/** A DB row carrying the four flattened columns. */
export interface AttendanceLocationRow {
  attendanceLatitude: number | null;
  attendanceLongitude: number | null;
  attendanceAllowedRadiusMeters: number | null;
  attendanceMaxAccuracyMeters: number | null;
}

/** Flat columns -> nested response shape; null when no coordinates were ever set. */
export function toAttendanceLocation(
  row: AttendanceLocationRow,
): AttendanceLocationDto | null {
  if (row.attendanceLatitude === null && row.attendanceLongitude === null) {
    return null;
  }
  return {
    latitude: row.attendanceLatitude ?? undefined,
    longitude: row.attendanceLongitude ?? undefined,
    allowedRadiusMeters: row.attendanceAllowedRadiusMeters ?? undefined,
    maxAccuracyMeters: row.attendanceMaxAccuracyMeters ?? undefined,
  };
}

/** Row -> API representation: the four flat columns are dropped and replaced by the nested `attendanceTakingLocation` object. */
export function withNestedAttendanceLocation<T extends AttendanceLocationRow>(
  row: T,
) {
  const {
    attendanceLatitude,
    attendanceLongitude,
    attendanceAllowedRadiusMeters,
    attendanceMaxAccuracyMeters,
    ...rest
  } = row;

  return { ...rest, attendanceTakingLocation: toAttendanceLocation(row) };
}
