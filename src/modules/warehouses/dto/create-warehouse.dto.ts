import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';

// Mirrors CreateBranchDto: a tenant now runs several warehouses, so one carries the same contact details and validation rules a branch does - `phoneNumber` and `email` are new since the 2026-08-19 migration.
export class CreateWarehouseDto {
  @IsString()
  @IsNotEmpty({ message: 'Tên kho không được để trống' })
  name: string;

  @IsArray()
  @ArrayNotEmpty({ message: 'Kho phải có ít nhất một số điện thoại' })
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  phoneNumber: string[];

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsEmail({}, { message: 'Email không hợp lệ' })
  email?: string;

  /** D-4: `false` makes this a damaged-goods warehouse, which other locations can name as their `damagedLocationId`. Defaults to `true`. */
  @IsOptional()
  @IsBoolean({ message: 'isSellable phải là true hoặc false' })
  isSellable?: boolean;

  /** D-4: where this warehouse's damaged / defective goods go - another non-sellable warehouse. `null` clears it. */
  @IsOptional()
  @IsUUID('all', { message: 'damagedLocationId không hợp lệ' })
  damagedLocationId?: string | null;
}
