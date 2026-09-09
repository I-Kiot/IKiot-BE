import { Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { NormalizeEmail } from '../../../common/decorators/normalize-email.decorator';

/** The personal details on a staff record. Flattened to `profile_*` columns in Postgres. */
export class StaffProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  lastName?: string;

  @IsOptional()
  @IsString()
  avatarUrl?: string;

  @IsOptional()
  @IsDateString()
  dob?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  taxNumber?: string;

  /** Vietnamese citizen ID. Shape and consistency with `dob`/`gender` are checked in the service - see `validateVietnamIdentificationId` for why the three have to agree. */
  @IsOptional()
  @IsString()
  identificationId?: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsIn(['MALE', 'FEMALE', 'OTHER'])
  gender?: string;
}

/** Ported from `updateStaffDTO` plus the checks `updateStaff` ran around it. `password`, `phoneNumber` and `status` are all refused here as they were: the first two have their own routes, and the account lifecycle runs guards a plain field write would skip (accepting `status` was a hole the first NestJS pass introduced). `systemRole` is absent so a STAFF account can never be promoted through this endpoint. */
export class UpdateUserDto {
  @IsOptional()
  @NormalizeEmail()
  email?: string;

  /** The tenant-defined Role this account holds. */
  @IsOptional()
  @IsUUID()
  roleId?: string;

  /** Where this person works. Setting one clears the other - a staff member is posted at exactly one location, and the service enforces that rather than trusting the client to send both halves. */
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @IsOptional()
  @IsUUID()
  warehouseId?: string;

  @IsOptional()
  @IsDateString()
  hireDate?: string;

  /** Which pay scheme this person is on. Must be an ACTIVE paysheet in the tenant. */
  @IsOptional()
  @IsUUID()
  paysheetId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  accountNote?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => StaffProfileDto)
  profile?: StaffProfileDto;
}
