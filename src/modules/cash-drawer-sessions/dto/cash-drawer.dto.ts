import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
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

/** Amounts here are whole đồng - there is no smaller unit in circulation, so a till count with decimals is a typo. */
export class OpenCashDrawerDto {
  /** Optional for someone posted at a branch - theirs is the only one they could mean - and required for an owner, who has none. */
  @IsOptional()
  @IsUUID()
  branchId?: string;

  /** Who takes the drawer first. Must be active staff at that branch. */
  @IsUUID()
  staffId: string;

  @Type(() => Number)
  @IsInt({ message: 'Số tiền đầu ca phải là số nguyên' })
  @Min(0, { message: 'Số tiền đầu ca không được âm' })
  openingAmount: number;
}

/** Ported from ShiftLogDTO. */
export class SubmitShiftLogDto {
  @IsIn(SHIFT_LOG_TYPES, {
    message: `type phải là ${SHIFT_LOG_TYPES.join(' hoặc ')}`,
  })
  type: string = ShiftLogType.END;

  /** What was counted in the drawer at that moment. */
  @Type(() => Number)
  @IsInt({ message: 'Số tiền phải là số nguyên' })
  @Min(0, { message: 'Số tiền không được âm' })
  amount: number;

  /** Only on an `END`, and only when handing over: the drawer stays open and becomes that person's. Rejected on a `START`, where it would mean nothing. */
  // "Not on a START" is checked in the service rather than with a second @ValidateIf, since stacking two on one property makes the winning rule depend on decorator order.
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

/** Ported from FinalizeCashDrawerDTO. */
export class FinalizeCashDrawerDto {
  /** What the manager actually counted when closing the day. */
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

/** Ported from CashDrawerQueryDTO (`YYYY-MM-DD` dates, as before). */
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

/** `GET /cash-drawer-sessions/current` takes only the branch. */
export class CurrentCashDrawerDto {
  @IsOptional()
  @IsUUID()
  branchId?: string;
}

/** `GET /cash-drawer-sessions/reconciliation` - the variance report over a range of days, separate from `QueryCashDrawerDto` because it compares each session against the ledger rather than listing them; hence the range cap and `varianceOnly`. */
export class QueryCashVarianceDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @IsOptional()
  @IsIn(CASH_DRAWER_STATUSES)
  status?: string;

  /** Business dates, `YYYY-MM-DD`. Defaults to the last 30 trading days. */
  @IsOptional()
  @IsDateString()
  fromDate?: string;

  @IsOptional()
  @IsDateString()
  toDate?: string;

  /** Only the days that did not balance. A still-open session has no counted total and therefore no variance, so it is excluded rather than reported as balanced. */
  @IsOptional()
  @Transform(
    ({ value }: { value: unknown }) => value === true || value === 'true',
  )
  @IsBoolean()
  varianceOnly?: boolean;
}
