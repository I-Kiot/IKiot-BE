import { Type } from 'class-transformer';
import {
  IsIn,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
} from 'class-validator';
import { PAYMENT_METHODS } from '../../../common/constants/payment-method';

export class PaySupplierDebtDto {
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive({ message: 'Số tiền thanh toán phải lớn hơn 0' })
  amount: number;

  /** Defaults to CASH, matching iKiotMS-BE. */
  @IsOptional()
  @IsIn(PAYMENT_METHODS)
  paymentMethod?: string;

  /** Free-text memo; becomes the CashFlow description when provided. */
  @IsOptional()
  @IsString()
  note?: string;
}
