import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Body của POST /orders/:id/pack – xác nhận đã đóng gói đơn (C-1). */
export class PackOrderDto {
  /** Ghi chú lúc đóng gói, vd. "thùng 2 móp góc, đã chèn thêm xốp". Lưu vào Fulfillment.exceptionNote. */
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'Ghi chú tối đa 500 ký tự' })
  note?: string;
}
