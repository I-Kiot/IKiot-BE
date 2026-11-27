import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { REFUND_METHODS } from '../../../common/constants/payment-method';

/** `POST /orders/:id/refund-excess`: hoàn phần khách chuyển dư so với tổng đơn. */
export class RefundExcessDto {
  /** Đồng, không vượt phần khách trả dư hiện tại (`paymentSummary.overpaidBy`). */
  @IsInt()
  @Min(1, { message: 'Số tiền hoàn phải lớn hơn 0' })
  amount: number;

  @IsIn(REFUND_METHODS, {
    message: `method phải là ${REFUND_METHODS.join(', ')}`,
  })
  method: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
