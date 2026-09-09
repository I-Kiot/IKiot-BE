import { Type } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

// `outstandingDebt` is deliberately absent: it is server-managed, rising on receipt of a stock movement and falling only through POST /suppliers/:id/payments. The generated DTO accepted it from the client, which let a caller rewrite the books with a PATCH.
export class CreateSupplierDto {
  @IsString()
  @IsNotEmpty({ message: 'Tên nhà cung cấp không được để trống' })
  supplierName: string;

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

  /** Ceiling the outstanding debt is checked against when receiving goods. 0 = no credit. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0, { message: 'Hạn mức công nợ không được âm' })
  creditLimit?: number;
}
