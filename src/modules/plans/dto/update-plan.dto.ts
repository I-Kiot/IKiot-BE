import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  MinLength,
} from 'class-validator';
import { VALID_PLAN_FEATURES } from '../../subscriptions/subscription.constants';

// planCode and billingCycle are intentionally absent - they are stable keys the upgrade/renew flow and the frontend's tier logic depend on, never editable after creation.
export class UpdatePlanDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  planName?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  displayFeatures?: string[];

  @IsOptional()
  @IsNumber()
  @Min(0)
  price?: number;

  @IsOptional()
  @IsInt()
  @Min(-1) // -1 = unlimited
  maxBranches?: number;

  @IsOptional()
  @IsInt()
  @Min(-1)
  maxWarehouses?: number;

  @IsOptional()
  @IsInt()
  @Min(-1)
  maxUsers?: number;

  @IsOptional()
  @IsInt()
  @Min(-1)
  maxProducts?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  trialDays?: number;

  @IsOptional()
  @IsArray()
  @IsIn(VALID_PLAN_FEATURES, { each: true })
  features?: string[];

  @IsOptional()
  @IsBoolean()
  isPopular?: boolean;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
