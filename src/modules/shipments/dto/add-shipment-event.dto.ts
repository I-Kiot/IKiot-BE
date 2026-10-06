import {
  IsIn,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ShipmentStatus } from '../../../common/constants/shipment-status';

/** Trạng thái một sự kiện nhật trình được mang (chốt 2026-10-06). DELIVERED / FAILED chỉ đi qua `deliver` (C-5) và `fail`. */
export const LOGGABLE_SHIPMENT_STATUSES: readonly string[] = [
  ShipmentStatus.OUT_FOR_DELIVERY,
];

/** Body của POST /shipments/:id/events – ghi nhật trình giao hàng (C-3). */
export class AddShipmentEventDto {
  @IsIn(LOGGABLE_SHIPMENT_STATUSES, {
    message: 'Nhật trình chỉ ghi được trạng thái "Đang đi giao"',
  })
  status: string;

  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'Ghi chú tối đa 500 ký tự' })
  note?: string;

  @IsOptional()
  @IsLatitude({ message: 'Vĩ độ không hợp lệ' })
  latitude?: number;

  @IsOptional()
  @IsLongitude({ message: 'Kinh độ không hợp lệ' })
  longitude?: number;
}
