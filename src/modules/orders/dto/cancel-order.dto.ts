import { Transform, Type } from 'class-transformer';
import { IsIn, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { DEPOSIT_METHODS } from '../../../common/constants/payment-method';

/** `POST /orders/:id/cancel` (A-5). */
export class CancelOrderDto {
  @IsOptional()
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  reason?: string;

  /** How much of the deposit goes back to the customer, 0 to the deposit still held. Required when the order holds a deposit - the rest is kept by the shop. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0, { message: 'Số tiền hoàn không được âm' })
  refundAmount?: number;

  /** How the refund is paid. Omitted = the way the deposit was taken. */
  @IsOptional()
  @IsIn(DEPOSIT_METHODS, {
    message: `refundMethod phải là ${DEPOSIT_METHODS.join(', ')}`,
  })
  refundMethod?: string;
}
