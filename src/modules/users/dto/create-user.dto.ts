import { Type } from 'class-transformer';
import {
  IsDateString,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { NormalizeEmail } from '../../../common/decorators/normalize-email.decorator';
import { StaffProfileDto } from './update-user.dto';

/** Puts a person on the books, INACTIVE and with no password: hiring someone and giving them a login are separate acts, so `POST /users/:id/account` is a separate call, and `deactivateAccount` parks somebody back in this state. Everything `UpdateUserDto` accepts is accepted here too - the first NestJS pass carried only seven fields, so the hire form's citizen ID, address, pay scheme and the rest were silently dropped by `whitelist: true` behind an HTTP 200. */
export class CreateUserDto {
  /** Shape is checked in the service by `validateVietnamPhoneNumber`: it is the login handle and the OTP destination, so it has to be a number that can actually receive an SMS. */
  @IsString()
  phoneNumber: string;

  @IsOptional()
  @NormalizeEmail()
  email?: string;

  @IsUUID()
  roleId: string;

  @IsOptional()
  @IsUUID()
  branchId?: string;

  @IsOptional()
  @IsUUID()
  warehouseId?: string;

  @IsOptional()
  @IsString()
  firstName?: string;

  @IsOptional()
  @IsString()
  lastName?: string;

  @IsOptional()
  @IsDateString()
  hireDate?: string;

  /** Which pay scheme this person is on. Must be an ACTIVE paysheet in the tenant. */
  @IsOptional()
  @IsUUID()
  paysheetId?: string;

  /** The personal details, the same nested object `PATCH /users/:id` takes. `firstName`/`lastName` are also accepted flat, as the old `StaffDTO` spelled them, and the service prefers whichever is set. */
  @IsOptional()
  @ValidateNested()
  @Type(() => StaffProfileDto)
  profile?: StaffProfileDto;
}
