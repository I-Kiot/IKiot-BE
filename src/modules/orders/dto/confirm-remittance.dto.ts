import { Type } from 'class-transformer';
import { IsNumber, IsOptional, IsString, Min } from 'class-validator';

/** `POST /orders/:id/confirm-remittance` (A-10): the owner counts the cash a shipper handed back. */
export class ConfirmRemittanceDto {
  /** What the owner actually received. It must be everything the shipper collected - a short hand-over is not settled here. */
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0, { message: 'Số tiền không được âm' })
  amount: number;

  @IsOptional()
  @IsString()
  note?: string;
}
