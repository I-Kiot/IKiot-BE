import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { SEPAY_RESOLUTIONS } from '../../../common/constants/payment-method';

/** Body đánh dấu đã xử lý giao dịch SePay. */
export class ResolveSepayTransactionDto {
  /** Cách xử lý: hoàn tay, đối chiếu tay hoặc bỏ qua. */
  @IsIn(SEPAY_RESOLUTIONS, {
    message: `resolution phải là ${SEPAY_RESOLUTIONS.join(', ')}`,
  })
  resolution: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
