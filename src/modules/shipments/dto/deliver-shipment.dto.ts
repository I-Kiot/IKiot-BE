import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  Min,
} from 'class-validator';
import { DELIVERY_COLLECTION_METHODS } from '../../../common/constants/payment-method';

/** Body của POST /shipments/:id/deliver – shipper xác nhận đã giao thành công và thu tiền (C-5). */
export class DeliverShipmentDto {
  /** Ảnh bằng chứng giao hàng (URL từ POST /uploads). Giao nội bộ cần ít nhất 1 ảnh. */
  @IsArray()
  @ArrayMaxSize(10, { message: 'Tối đa 10 ảnh bằng chứng' })
  @IsUrl({}, { each: true, message: 'Ảnh bằng chứng phải là đường dẫn hợp lệ' })
  proofPhotoUrls: string[];

  /** CASH | BANK_TRANSFER_QR | NONE (đã cọc đủ). */
  @IsIn(DELIVERY_COLLECTION_METHODS, {
    message: 'Cách thu tiền không hợp lệ',
  })
  paymentMethod: string;

  /** Số tiền thu được – phải bằng đúng số còn phải thu. */
  @Type(() => Number)
  @IsNumber({}, { message: 'Số tiền thu phải là số' })
  @Min(0, { message: 'Số tiền thu không được âm' })
  collectedAmount: number;

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
