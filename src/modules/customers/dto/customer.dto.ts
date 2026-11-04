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

/** Port từ CreateCustomerDTO của iKiotMS-BE. */
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

  // Không qua validateVietnamPhoneNumber: SĐT khách là thông tin liên lạc gõ từ hoá đơn, từ chối số bàn sẽ làm đơn không lên được.
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

/** `isDeleted` cố ý không có ở đây - DELETE mới là thứ đặt nó. */
export class UpdateCustomerDto extends PartialType(CreateCustomerDto) {}

export class QueryCustomerDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  search?: string;

  @IsOptional()
  @IsUUID()
  branchId?: string;
}

/** Port từ `DELETE /customers` hàng loạt của bản cũ. */
export class DeleteManyCustomersDto {
  @IsArray()
  @ArrayNotEmpty({ message: 'Cần chọn ít nhất một khách hàng' })
  @IsUUID('4', { each: true })
  @Type(() => String)
  ids: string[];
}
