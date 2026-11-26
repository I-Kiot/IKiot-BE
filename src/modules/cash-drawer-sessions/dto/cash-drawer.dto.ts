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

/** Số tiền là đồng nguyên. */
export class OpenCashDrawerDto {
  /** Chi nhánh, bắt buộc với chủ shop. */
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

  /** Người nhận bàn giao, chỉ có ở END. */
  // Kiểm trong service thay vì thêm decorator.
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

/** Query báo cáo chênh lệch két qua nhiều ngày. */
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

  /** Chỉ các ngày không khớp. */
  @BooleanQuery()
  varianceOnly?: boolean;
}
