import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Shipper xác nhận đã tới kho lấy hàng. Ghi chú lưu vào nhật trình shipment. */
export class PickUpShipmentDto {
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'Ghi chú tối đa 500 ký tự' })
  note?: string;
}
