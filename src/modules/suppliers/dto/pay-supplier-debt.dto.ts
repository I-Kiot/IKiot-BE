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

  /** Mặc định CASH, như bản cũ. */
  @IsOptional()
  @IsIn(PAYMENT_METHODS)
  paymentMethod?: string;

  /** Ghi chú tự do; có thì thành mô tả của CashFlow. */
  @IsOptional()
  @IsString()
  note?: string;
}
