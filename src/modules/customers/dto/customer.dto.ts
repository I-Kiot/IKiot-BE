import { PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsDateString,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';

export const CUSTOMER_GENDERS: readonly string[] = ['MALE', 'FEMALE', 'OTHER'];

/** Ported from iKiotMS-BE's CreateCustomerDTO. */
export class CreateCustomerDto {
  @IsString()
  @IsNotEmpty({ message: 'Tên khách hàng không được để trống' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  name: string;

  @IsOptional()
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  customerCode?: string;

  // Not run through validateVietnamPhoneNumber: a customer's number is a contact detail typed off a receipt, and refusing a landline would stop a sale.
  @IsOptional()
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  phone?: string;

  @IsOptional()
  @IsIn(CUSTOMER_GENDERS, {
    message: `gender phải là ${CUSTOMER_GENDERS.join(', ')}`,
  })
  gender?: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsDateString()
  dob?: string;
}

/** `isDeleted` is absent on purpose - DELETE is what sets it. */
export class UpdateCustomerDto extends PartialType(CreateCustomerDto) {}

export class QueryCustomerDto extends PaginationQueryDto {
  /** Partial, case-insensitive match on name or phone. */
  @IsOptional()
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  search?: string;

  /** Only customers who have bought at this branch. */
  @IsOptional()
  @IsUUID()
  branchId?: string;
}

/** Ported from the old bulk `DELETE /customers`. */
export class DeleteManyCustomersDto {
  @IsArray()
  @ArrayNotEmpty({ message: 'Cần chọn ít nhất một khách hàng' })
  @IsUUID('4', { each: true })
  @Type(() => String)
  ids: string[];
}
