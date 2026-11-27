import { IsUUID } from 'class-validator';

/** Chỉ đổi được shipment INTERNAL chưa kết thúc (C-8). */
export class ChangeDriverDto {
  @IsUUID('4', { message: 'Shipper không hợp lệ' })
  driverId: string;
}
