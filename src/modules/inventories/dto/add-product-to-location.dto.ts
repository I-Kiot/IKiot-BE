import { IsUUID } from 'class-validator';
import { LocationIdDto } from '../../../common/dto/location-ref.dto';

/** Không nhận `stock`: địa điểm bắt đầu từ 0, tồn chỉ đổi qua bán hàng hoặc phiếu kho (đều có vết). */
export class AddProductToLocationDto extends LocationIdDto {
  @IsUUID()
  productItemId: string;
}
