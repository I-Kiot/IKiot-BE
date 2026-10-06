import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Body của POST /orders/:id/ship – xác nhận đơn chuyển sang Đang vận chuyển (C-2). Ghi chú lưu vào nhật trình shipment. */
export class ShipOrderDto {
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'Ghi chú tối đa 500 ký tự' })
  note?: string;
}
