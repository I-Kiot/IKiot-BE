import { Type } from 'class-transformer';
import {
  IsIn,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
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

  /** Trả bằng tiền mặt từ két của chi nhánh này (quỹ DRAWER, vào đối soát két). Bỏ trống: tiền của chủ, không qua két nào (quỹ OWNER). Chỉ chọn được nơi mình được làm việc. */
  @IsOptional()
  @IsUUID()
  locationId?: string;

  /** Ghi chú tự do; có thì thành mô tả của CashFlow. */
  @IsOptional()
  @IsString()
  note?: string;
}
