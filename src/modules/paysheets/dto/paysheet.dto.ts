import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';

const trim = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );

export const PAY_TYPES = ['PAY_BY_SHIFT', 'STANDARD_WORKING_DAY', 'FIXED'];
export const AMOUNT_TYPES = ['FIXED_AMOUNT', 'PERCENTAGE'];
export const DEDUCTION_TYPES = ['LATE', 'EARLY_LEAVE', 'FIXED'];
export const CONDITION_TYPES = ['BY_OCCURRENCE', 'BY_BLOCK'];
export const BONUS_TYPES = [
  'EMPLOYEE_REVENUE',
  'MINIMUM_AVENUE_INCOME',
  'BRANCH_REVENUE',
];
export const CALCULATION_TYPES = [
  'GROSS_REVENUE',
  'NET_REVENUE',
  'COLLECTED_REVENUE',
];

/** How the base salary is worked out; which of the three amounts matters depends on `payType`, and generation refuses a FIXED employee with no `salaryPerPeriod` rather than paying zero. */
export class BasicPayDto {
  @IsIn(PAY_TYPES, { message: `payType phải là ${PAY_TYPES.join(', ')}` })
  payType: string;

  /** PAY_BY_SHIFT: what one shift is worth. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  amountPerShift?: number;

  /** FIXED: the whole period's salary, prorated by days actually worked. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  salaryPerPeriod?: number;

  /** STANDARD_WORKING_DAY: what one full day is worth. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  standardWorkingDaySalary?: number;

  // Multipliers. A public holiday outranks a weekend rather than stacking with it - see payroll-math.ts.
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  rateWeekend?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  ratePublicHoliday?: number;
}

export class OvertimeDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  normalDay?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  weekend?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  publicHoliday?: number;
}

export class AllowanceDto {
  @IsString()
  @trim()
  @IsNotEmpty({ message: 'Tên phụ cấp là bắt buộc' })
  name: string;

  @IsOptional()
  @IsBoolean()
  enable?: boolean;

  @IsIn(AMOUNT_TYPES)
  amountType: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  amountValue: number;
}

/** A penalty. `conditionType` only applies to LATE/EARLY_LEAVE - a FIXED deduction is charged once per period regardless of behaviour. */
export class DeductionDto {
  @IsString()
  @trim()
  @IsNotEmpty({ message: 'Tên khoản trừ là bắt buộc' })
  name: string;

  @IsOptional()
  @IsBoolean()
  enable?: boolean;

  @IsIn(DEDUCTION_TYPES)
  deductionType: string;

  @IsOptional()
  @IsIn(CONDITION_TYPES)
  conditionType?: string;

  /** Required for BY_BLOCK: each violation is rounded up to whole blocks separately. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  blockMinutes?: number;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  deductionValue: number;
}

export class BonusTierDto {
  @IsOptional()
  @IsString()
  @trim()
  name?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  fromValue?: number;

  @IsOptional()
  @IsIn(AMOUNT_TYPES)
  rewardType?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  rewardValue?: number;
}

/** Revenue-linked bonuses, priced by `payBonuses` since 2026-09-06 (both codebases previously stored the configuration and wrote a literal `bonus = 0`). Read that function first: the tier model and the meaning of `MINIMUM_AVENUE_INCOME` are decisions, not ports. */
export class BonusDto {
  @IsIn(BONUS_TYPES)
  bonusType: string;

  @IsIn(CALCULATION_TYPES)
  calculationType: string;

  @IsOptional()
  @IsBoolean()
  enable?: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BonusTierDto)
  tiers?: BonusTierDto[];
}

/** Create and update take the same body, as the old service did, so a PATCH here is a full replace of the nested collections. */
export class PaysheetDto {
  @IsString()
  @trim()
  @IsNotEmpty({ message: 'Tên bảng lương là bắt buộc' })
  name: string;

  @ValidateNested()
  @Type(() => BasicPayDto)
  basicPay: BasicPayDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => OvertimeDto)
  overtime?: OvertimeDto;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AllowanceDto)
  allowances?: AllowanceDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DeductionDto)
  deductions?: DeductionDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BonusDto)
  bonuses?: BonusDto[];
}

export class QueryPaysheetDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  @trim()
  name?: string;
}
