import { IsUUID } from 'class-validator';

export class QueryDriversDto {
  @IsUUID('4', { message: 'Mã đơn hàng không hợp lệ' })
  orderId: string;
}
