import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Giao hàng cho khách tại quầy. Cả hai trường đều tuỳ chọn, không bắt ảnh như giao tận nơi. */
export class PickupHandOverDto {
  /** Người thực tế nhận hàng, khi khác người đặt. */
  @IsOptional()
  @IsString()
  @MaxLength(200, { message: 'Tên người nhận tối đa 200 ký tự' })
  receiverName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'Ghi chú tối đa 500 ký tự' })
  note?: string;
}
