import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import {
  APPLICABLE_RULE_TYPES,
  ApplicableRuleType,
  DISCOUNT_TYPES,
  DiscountType,
  PROMOTION_STATUSES,
} from '../promotion.constants';

/** What the promotion applies to. Mongo stored this as a subdocument; the API keeps it. */
export class ApplicableRuleDto {
  @IsIn(APPLICABLE_RULE_TYPES, {
    message: `applicableRule.type phải là ${APPLICABLE_RULE_TYPES.join(', ')}`,
  })
  type: string;

  @ValidateIf((r: ApplicableRuleDto) => r.type === ApplicableRuleType.CATEGORY)
  @IsArray()
  @ArrayNotEmpty({ message: 'Cần chọn ít nhất một danh mục' })
  @IsUUID('4', { each: true })
  categoryIds?: string[];

  @ValidateIf((r: ApplicableRuleDto) => r.type === ApplicableRuleType.PRODUCT)
  @IsArray()
  @ArrayNotEmpty({ message: 'Cần chọn ít nhất một mặt hàng' })
  @IsUUID('4', { each: true })
  productItemIds?: string[];
}

/** Ported from CreatePromotionRequestDTO. `usedCount` is server-managed and `status` is reached through DELETE, which is what deactivates a promotion. */
export class CreatePromotionDto {
  @IsString()
  @IsNotEmpty({ message: 'Tên khuyến mãi không được để trống' })
  promoName: string;

  @IsOptional()
  @IsString()
  description?: string;

  /** Empty (or omitted) = applies tenant-wide. Non-empty = only at these branches. */
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  branchIds?: string[];

  @IsIn(DISCOUNT_TYPES, {
    message: `discountType phải là ${DISCOUNT_TYPES.join(' hoặc ')}`,
  })
  discountType: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01, { message: 'Giá trị giảm phải lớn hơn 0' })
  // A percentage over 100 would pay the customer; the engine clamps, but a plan that says 150% is a typo worth rejecting at the door.
  @ValidateIf(
    (p: CreatePromotionDto) => p.discountType === DiscountType.PERCENT,
  )
  @Max(100, { message: 'Giảm theo phần trăm không được vượt quá 100' })
  discountValue: number;

  /** Only meaningful for PERCENT - a cap on a fixed amount is just a smaller fixed amount. */
  @IsOptional()
  @ValidateIf((p: CreatePromotionDto) => p.maxDiscountAmount !== undefined)
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01, { message: 'maxDiscountAmount phải lớn hơn 0' })
  maxDiscountAmount?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0, { message: 'Giá trị đơn tối thiểu không được âm' })
  minOrderValue?: number;

  @ValidateNested()
  @Type(() => ApplicableRuleDto)
  applicableRule: ApplicableRuleDto;

  @IsDateString()
  startDate: string;

  @IsDateString()
  endDate: string;

  @IsOptional()
  @IsBoolean()
  stackable?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1, { message: 'usageLimit phải từ 1 trở lên' })
  usageLimit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1, { message: 'usageLimitPerCustomer phải từ 1 trở lên' })
  usageLimitPerCustomer?: number;
}

/** Ported from UpdatePromotionRequestDTO, not `PartialType(CreatePromotionDto)`: the conditional rules read sibling fields that may be absent on a partial update, so the service re-checks the merged result instead. */
export class UpdatePromotionDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'Tên khuyến mãi không được để trống' })
  promoName?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  branchIds?: string[];

  @IsOptional()
  @IsIn(DISCOUNT_TYPES)
  discountType?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  discountValue?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  maxDiscountAmount?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  minOrderValue?: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => ApplicableRuleDto)
  applicableRule?: ApplicableRuleDto;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @IsBoolean()
  stackable?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  usageLimit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  usageLimitPerCustomer?: number;

  @IsOptional()
  @IsIn(PROMOTION_STATUSES)
  status?: string;
}

/** Ported from PromotionQueryDTO (`recordPerPage` → `limit`, as elsewhere). */
export class QueryPromotionDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  search?: string;

  @IsOptional()
  @IsIn(PROMOTION_STATUSES)
  status?: string;

  @IsOptional()
  @IsUUID()
  branchId?: string;
}

/** One line of the cart being priced. */
export class CartItemDto {
  @IsUUID()
  productItemId: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1, { message: 'Số lượng phải từ 1 trở lên' })
  quantity: number;

  // No `unitPrice`: the price is read from `ProductItem.retailPrice` server-side, and anything sent is dropped by the global whitelist.
}

/** Ported from PromotionCalculateRequestDTO - the payload behind `/candidates`, `/calculate` and `/apply`. */
export class PriceCartDto {
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @IsOptional()
  @IsUUID()
  customerId?: string;

  /** Required by `/apply` only - the order the discount is being committed against. */
  @IsOptional()
  @IsUUID()
  orderId?: string;

  @IsArray()
  @ArrayNotEmpty({ message: 'Giỏ hàng phải có ít nhất một mặt hàng' })
  @ValidateNested({ each: true })
  @Type(() => CartItemDto)
  items: CartItemDto[];

  /** The exact promotions the user picked. Empty is valid and means "no discount". */
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  promotionIds?: string[];
}
