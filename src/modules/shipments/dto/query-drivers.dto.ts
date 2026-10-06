import { IsUUID } from 'class-validator';

/** Query của GET /shipments/drivers – danh sách shipper chọn được cho một đơn (C-9). */
export class QueryDriversDto {
  @IsUUID('4', { message: 'Mã đơn hàng không hợp lệ' })
  orderId: string;
}
