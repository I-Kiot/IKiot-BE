import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Khách không chuyển khoản QR, shipper thu tiền mặt thay (C-5). */
export class PayCashDto {
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'Ghi chú tối đa 500 ký tự' })
  note?: string;
}
