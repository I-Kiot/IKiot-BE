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

// Giống CreateBranchDto: tenant giờ có nhiều kho nên cùng thông tin liên hệ và luật kiểm như chi nhánh (`phoneNumber`, `email` mới từ migration 2026-08-19).
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

  /** D-4: `false` làm kho này thành kho hàng hỏng, nơi các địa điểm khác có thể chỉ định làm `damagedLocationId`. Mặc định `true`. */
  @IsOptional()
  @IsBoolean({ message: 'isSellable phải là true hoặc false' })
  isSellable?: boolean;

  /** D-4: hàng hỏng của kho này về đâu, một kho không bán được khác. `null` để xoá. */
  @IsOptional()
  @IsUUID('all', { message: 'damagedLocationId không hợp lệ' })
  damagedLocationId?: string | null;
}
