import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** Body của POST /shipments/:id/fail – giao không thành (C-3). Lý do bắt buộc: người xử lý hoàn hàng cần biết vì sao. */
export class FailShipmentDto {
  @IsString()
  @IsNotEmpty({ message: 'Cần ghi lý do giao không thành' })
  @MaxLength(500, { message: 'Ghi chú tối đa 500 ký tự' })
  note: string;
}
