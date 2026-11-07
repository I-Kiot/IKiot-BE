import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PICKUP_COLLECTION_METHODS } from '../../../common/constants/payment-method';

/** Thu số còn lại của đơn khách tới lấy, tại quầy. Số tiền do server tính, không nhận từ client. */
export class PickupCollectDto {
  @IsIn(PICKUP_COLLECTION_METHODS, {
    message: `method phải là ${PICKUP_COLLECTION_METHODS.join(', ')}`,
  })
  method!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'Ghi chú tối đa 500 ký tự' })
  note?: string;
}
