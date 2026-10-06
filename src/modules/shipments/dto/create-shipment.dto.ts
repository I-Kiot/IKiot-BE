import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';
import { CARRIER_TYPES } from '../../../common/constants/shipment-status';

/** Body của POST /shipments – ghi nhận "ĐVVC đã lấy hàng" cho một đơn đã đóng gói (C-2, gán shipper C-8). Không có trạng thái, người thao tác hay địa chỉ: server tự lấy. */
export class CreateShipmentDto {
  @IsUUID('4', { message: 'Mã đơn hàng không hợp lệ' })
  orderId: string;

  /** INTERNAL = shipper / thợ của shop (bắt buộc `driverId`); EXTERNAL = ĐVVC ngoài. */
  @IsIn(CARRIER_TYPES, { message: 'Hình thức giao không hợp lệ' })
  carrierType: string;

  @IsOptional()
  @IsString()
  @MaxLength(100, { message: 'Tên đơn vị vận chuyển tối đa 100 ký tự' })
  carrierName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100, { message: 'Mã vận đơn tối đa 100 ký tự' })
  trackingCode?: string;

  @IsOptional()
  @IsUUID('4', { message: 'Shipper không hợp lệ' })
  driverId?: string;

  /** Ngày hẹn giao, `YYYY-MM-DD`. */
  @IsOptional()
  @IsDateString({ strict: true }, { message: 'Ngày hẹn giao không hợp lệ' })
  scheduledDate?: string;

  /** Khung giờ hẹn, vd. "08:00-12:00". */
  @IsOptional()
  @IsString()
  @MaxLength(50, { message: 'Khung giờ hẹn tối đa 50 ký tự' })
  scheduledSlot?: string;

  @IsOptional()
  @IsBoolean()
  requiresInstallation?: boolean;

  /** Phí ĐVVC tính cho shop (khác phí ship thu của khách). */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'Phí vận chuyển phải là số' })
  @Min(0, { message: 'Phí vận chuyển không được âm' })
  shippingCost?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'Ghi chú tối đa 500 ký tự' })
  note?: string;
}
