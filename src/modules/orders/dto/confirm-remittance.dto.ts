import { Type } from 'class-transformer';
import { IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class ConfirmRemittanceDto {
  /** Số tiền chủ thực nhận. Phải đủ toàn bộ số shipper đã thu; bàn giao thiếu không được chốt ở đây. */
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0, { message: 'Số tiền không được âm' })
  amount: number;

  @IsOptional()
  @IsString()
  note?: string;
}
