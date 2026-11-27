import { Transform, Type } from 'class-transformer';
import { IsIn, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { DEPOSIT_METHODS } from '../../../common/constants/payment-method';

export class CancelOrderDto {
  @IsOptional()
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  reason?: string;

  /** Phần cọc hoàn cho khách (0 = shop giữ hết), bắt buộc khi đơn đang giữ cọc. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0, { message: 'Số tiền hoàn không được âm' })
  refundAmount?: number;

  /** Hình thức hoàn tiền. Bỏ trống = theo cách đã thu cọc. */
  @IsOptional()
  @IsIn(DEPOSIT_METHODS, {
    message: `refundMethod phải là ${DEPOSIT_METHODS.join(', ')}`,
  })
  refundMethod?: string;
}
