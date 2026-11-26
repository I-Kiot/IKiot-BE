import { Type } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { SUPPLIER_TYPES } from '../../../common/constants/inventory-ledger';

// Công nợ do server quản lý.
export class CreateSupplierDto {
  @IsString()
  @IsNotEmpty({ message: 'Tên nhà cung cấp không được để trống' })
  supplierName: string;

  /** Loại NCC: GOODS hoặc WORKSHOP, khoá sau khi có phiếu. */
  @IsOptional()
  @IsIn(SUPPLIER_TYPES, {
    message: `Loại nhà cung cấp phải là ${SUPPLIER_TYPES.join(' hoặc ')}`,
  })
  type?: string;

  @IsOptional()
  @IsString()
  contactName?: string;

  @IsOptional()
  @IsString()
  phoneNumber?: string;

  @IsOptional()
  @IsEmail({}, { message: 'Email không hợp lệ' })
  email?: string;

  @IsOptional()
  @IsString()
  address?: string;

  /** Trần công nợ kiểm khi nhận hàng. 0 = không cho nợ. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0, { message: 'Hạn mức công nợ không được âm' })
  creditLimit?: number;
}
