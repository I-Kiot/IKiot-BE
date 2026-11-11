import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { SEPAY_RESOLUTIONS } from '../../../common/constants/payment-method';

/** Chủ shop đánh dấu đã xử lý xong một giao dịch SePay chưa chốt (`POST /sepay-transactions/:id/resolve`). */
export class ResolveSepayTransactionDto {
  /** REFUNDED_MANUALLY: đã hoàn tiền ngoài hệ thống (ghi dòng chi `UNALLOCATED_REFUND`); MATCHED_MANUALLY: đã đối chiếu với đơn; IGNORED: bỏ qua. */
  @IsIn(SEPAY_RESOLUTIONS, {
    message: `resolution phải là ${SEPAY_RESOLUTIONS.join(', ')}`,
  })
  resolution: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
