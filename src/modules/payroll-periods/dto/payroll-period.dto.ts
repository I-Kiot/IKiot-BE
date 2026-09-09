import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { PAYROLL_PERIOD_STATUSES } from '../payroll-period.constants';

const trim = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );

/** `POST /payroll/periods` and `POST /payroll/preview` for a whole month. */
export class GeneratePayrollDto {
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, {
    message: 'Tháng lương phải có định dạng YYYY-MM',
  })
  payrollMonth: string;

  /** Omitted = every eligible employee. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  userIds?: string[];
}

/** `POST /payroll/preview` for an arbitrary range - a what-if, never persisted. */
export class PreviewPayrollDto {
  @IsDateString({}, { message: 'periodStartDate không hợp lệ' })
  periodStartDate: string;

  @IsDateString({}, { message: 'periodEndDate không hợp lệ' })
  periodEndDate: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  userIds?: string[];
}

/** The body every status transition shares. `paymentMethod` is deliberately absent: payouts are recorded as cash, and letting a client label one BANK_TRANSFER or SEPAY would mark money as having moved through an integration it never touched. */
export class PayrollActionDto {
  /** Required for CANCEL and RETURN_TO_DRAFT - checked in the service, which knows which. */
  @IsOptional()
  @IsString()
  @trim()
  @MaxLength(500, { message: 'Lý do không được vượt quá 500 ký tự' })
  reason?: string;

  @IsOptional()
  @IsString()
  @trim()
  @MaxLength(200)
  paymentReference?: string;

  @IsOptional()
  @IsString()
  @trim()
  @MaxLength(500)
  paymentNote?: string;
}

export const ADJUSTMENT_CATEGORIES = ['SALARY_ADVANCE', 'TET_BONUS', 'OTHER'];

/** A one-off line a manager adds to a draft payslip - an advance already handed over, a Tết bonus. Signed: negative takes money off. */
export class ManualAdjustmentDto {
  @IsOptional()
  @IsIn(ADJUSTMENT_CATEGORIES, { message: 'Loại điều chỉnh không hợp lệ' })
  category?: string;

  @IsString()
  @trim()
  @IsNotEmpty({ message: 'Tên điều chỉnh là bắt buộc' })
  @MaxLength(200)
  name: string;

  /** Zero is rejected: an adjustment that changes nothing is a mistake, not a line item. */
  @Type(() => Number)
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: 'Số tiền điều chỉnh phải khác 0' },
  )
  amount: number;

  @IsOptional()
  @IsString()
  @trim()
  @MaxLength(500)
  note?: string;
}

/** `PATCH /payroll/periods/:periodId/payslips/:payslipId`, DRAFT only. */
export class UpdateDraftPayslipDto {
  @IsOptional()
  @IsString()
  @trim()
  @MaxLength(1000)
  note?: string;

  /** Replaces the whole list, as the old endpoint did. */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ManualAdjustmentDto)
  manualAdjustments?: ManualAdjustmentDto[];
}

export class QueryPayrollPeriodDto extends PaginationQueryDto {
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsIn(PAYROLL_PERIOD_STATUSES, {
    message: 'Trạng thái kỳ lương không hợp lệ',
  })
  status?: string;
}
