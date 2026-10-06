import { IsUUID } from 'class-validator';

/** Body của PATCH /shipments/:id/driver – đổi shipper / thợ của một shipment INTERNAL chưa kết thúc (C-8). */
export class ChangeDriverDto {
  @IsUUID('4', { message: 'Shipper không hợp lệ' })
  driverId: string;
}
