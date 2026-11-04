import { BooleanQuery } from '../../../common/decorators/boolean-query.decorator';
import { Transform, Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import {
  CASH_DRAWER_STATUSES,
  SHIFT_LOG_TYPES,
  ShiftLogType,
} from '../cash-drawer.constants';

/** Số tiền ở đây là đồng nguyên, không có đơn vị nhỏ hơn đang lưu hành, nên kiểm đếm két có số lẻ là lỗi nhập. */
export class OpenCashDrawerDto {
  /** Không bắt buộc với người được gán chi nhánh (chỉ có một chi nhánh khả dĩ); bắt buộc với owner vì owner không gắn chi nhánh nào. */
  @IsOptional()
  @IsUUID()
  branchId?: string;

  /** Ai nhận két đầu tiên. Phải là nhân viên đang hoạt động tại chi nhánh đó. */
  @IsUUID()
  staffId: string;

  @Type(() => Number)
  @IsInt({ message: 'Số tiền đầu ca phải là số nguyên' })
  @Min(0, { message: 'Số tiền đầu ca không được âm' })
  openingAmount: number;
}

/** Port từ ShiftLogDTO. */
export class SubmitShiftLogDto {
  @IsIn(SHIFT_LOG_TYPES, {
    message: `type phải là ${SHIFT_LOG_TYPES.join(' hoặc ')}`,
  })
  type: string = ShiftLogType.END;

  @Type(() => Number)
  @IsInt({ message: 'Số tiền phải là số nguyên' })
  @Min(0, { message: 'Số tiền không được âm' })
  amount: number;

  /** Chỉ có ở `END`, và chỉ khi bàn giao: két vẫn mở và thành của người được giao. Bị từ chối ở `START` vì không có nghĩa. */
  // Kiểm "không có ở START" trong service thay vì thêm @ValidateIf thứ hai, vì xếp hai decorator trên cùng một property làm rule thắng phụ thuộc thứ tự decorator.
  @IsOptional()
  @IsUUID()
  nextStaffId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  note?: string;
}

/** Port từ FinalizeCashDrawerDTO. */
export class FinalizeCashDrawerDto {
  @Type(() => Number)
  @IsInt({ message: 'Số tiền cuối ca phải là số nguyên' })
  @Min(0, { message: 'Số tiền cuối ca không được âm' })
  finalAmount: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  note?: string;
}

/** Port từ CashDrawerQueryDTO (ngày dạng `YYYY-MM-DD`, như trước). */
export class QueryCashDrawerDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @IsOptional()
  @IsIn(CASH_DRAWER_STATUSES)
  status?: string;

  @IsOptional()
  @IsDateString()
  fromDate?: string;

  @IsOptional()
  @IsDateString()
  toDate?: string;
}

export class CurrentCashDrawerDto {
  @IsOptional()
  @IsUUID()
  branchId?: string;
}

/** `GET /cash-drawer-sessions/reconciliation` - báo cáo chênh lệch qua nhiều ngày, tách khỏi `QueryCashDrawerDto` vì nó so từng phiên với sổ quỹ thay vì liệt kê; vì vậy có giới hạn khoảng ngày và `varianceOnly`. */
export class QueryCashVarianceDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @IsOptional()
  @IsIn(CASH_DRAWER_STATUSES)
  status?: string;

  /** Ngày nghiệp vụ, `YYYY-MM-DD`. Mặc định 30 ngày giao dịch gần nhất. */
  @IsOptional()
  @IsDateString()
  fromDate?: string;

  @IsOptional()
  @IsDateString()
  toDate?: string;

  /** Chỉ các ngày không khớp. Phiên còn mở chưa có tổng đếm nên không có chênh lệch; nó bị loại chứ không được báo là khớp. */
  @BooleanQuery()
  varianceOnly?: boolean;
}
