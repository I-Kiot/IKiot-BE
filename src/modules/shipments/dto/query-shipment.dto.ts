import { Transform } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import {
  CARRIER_TYPES,
  SHIPMENT_STATUSES,
} from '../../../common/constants/shipment-status';

const LOCAL_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Query của GET /shipments (C-3). `from` / `to` là ngày theo giờ Việt Nam, tính trọn ngày. */
export class QueryShipmentDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(SHIPMENT_STATUSES, { message: 'Trạng thái giao hàng không hợp lệ' })
  status?: string;

  @IsOptional()
  @IsIn(CARRIER_TYPES, { message: 'Hình thức giao không hợp lệ' })
  carrierType?: string;

  @IsOptional()
  @IsUUID('4', { message: 'Shipper không hợp lệ' })
  driverId?: string;

  /** Ngày tạo từ (gồm cả ngày này), `YYYY-MM-DD`. */
  @IsOptional()
  @Matches(LOCAL_DAY, { message: 'Ngày bắt đầu phải có dạng YYYY-MM-DD' })
  from?: string;

  /** Ngày tạo tới (gồm cả ngày này), `YYYY-MM-DD`. */
  @IsOptional()
  @Matches(LOCAL_DAY, { message: 'Ngày kết thúc phải có dạng YYYY-MM-DD' })
  to?: string;

  /** Mã đơn, mã vận đơn, tên hoặc SĐT người nhận. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(100, { message: 'Từ khoá tối đa 100 ký tự' })
  search?: string;
}
