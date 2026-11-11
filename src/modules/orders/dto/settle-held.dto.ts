import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { REFUND_METHODS } from '../../../common/constants/payment-method';

export const SETTLE_HELD_ACTIONS = ['REFUND', 'KEEP'] as const;

/** `POST /orders/:id/settle-held`: quyết định số tiền treo của đơn đã kết thúc (`paymentSummary.heldUndecided`). */
export class SettleHeldDto {
  /** REFUND = hoàn cho khách (`amount` ≤ số treo, mặc định hoàn hết); KEEP = giữ toàn bộ phần treo, ghi thu nhập khác (không có `amount`). */
  @IsIn(SETTLE_HELD_ACTIONS, {
    message: `action phải là ${SETTLE_HELD_ACTIONS.join(', ')}`,
  })
  action: (typeof SETTLE_HELD_ACTIONS)[number];

  /** Đồng. Chỉ cho REFUND; phần treo còn lại sau hoàn một phần vẫn chưa quyết định. */
  @ValidateIf((o: SettleHeldDto) => o.action === 'REFUND')
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1, { message: 'Số tiền hoàn phải lớn hơn 0' })
  amount?: number;

  @ValidateIf((o: SettleHeldDto) => o.action === 'REFUND')
  @IsOptional()
  @IsIn(REFUND_METHODS, {
    message: `method phải là ${REFUND_METHODS.join(', ')}`,
  })
  method?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
