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

  /**
   * Chỉ cho đánh dấu hỏng: chiếc may riêng cho dòng đơn này (lô `orderItemId`). Bỏ trống = hàng dùng chung trên kệ.
   * Sửa xong / huỷ bỏ qua trường này (rút mọi lô hỏng theo FIFO).
   */
  @IsOptional()
  @IsUUID()
  orderItemId?: string;

  /** Lý do (trầy, rách đệm, thanh lý...). Ghi vào sổ kho. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
