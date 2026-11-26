import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

/** Đánh dấu hỏng / sửa xong / huỷ hàng hỏng trên một dòng tồn (2026-11-26). */
export class DamagedStockDto {
  @Type(() => Number)
  @IsInt({ message: 'quantity phải là số nguyên' })
  @Min(1, { message: 'quantity phải lớn hơn 0' })
  quantity: number;

  /** Chiếc may riêng cho dòng đơn này; bỏ trống là hàng dùng chung. */
  @IsOptional()
  @IsUUID()
  orderItemId?: string;

  /** Lý do (trầy, rách đệm, thanh lý...). Ghi vào sổ kho. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
