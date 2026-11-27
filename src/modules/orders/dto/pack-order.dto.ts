import { IsOptional, IsString, MaxLength } from 'class-validator';

export class PackOrderDto {
  /** Ghi chú lúc đóng gói (vd. "thùng 2 móp góc"), lưu vào `Fulfillment.exceptionNote`. */
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'Ghi chú tối đa 500 ký tự' })
  note?: string;
}
