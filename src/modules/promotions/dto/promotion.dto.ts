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

/** Phạm vi áp dụng. Bản Mongo cũ lưu dạng subdocument; API giữ nguyên hình dạng này. */
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

/** Port từ CreatePromotionRequestDTO. `usedCount` do server quản lý; `status` chỉ đổi qua DELETE (đó là cách vô hiệu hoá khuyến mãi). */
export class CreatePromotionDto {
  @IsString()
  @IsNotEmpty({ message: 'Tên khuyến mãi không được để trống' })
  promoName: string;

  @IsOptional()
  @IsString()
  description?: string;

  /** Rỗng hoặc bỏ trống = áp dụng toàn chuỗi; có giá trị = chỉ tại các chi nhánh này. */
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
  // Giảm trên 100% sẽ trả tiền cho khách. Engine có kẹp giá trị, nhưng nhập 150% là lỗi gõ nên chặn ngay từ đầu vào.
  @ValidateIf(
    (p: CreatePromotionDto) => p.discountType === DiscountType.PERCENT,
  )
  @Max(100, { message: 'Giảm theo phần trăm không được vượt quá 100' })
  discountValue: number;

  /** Chỉ có nghĩa với PERCENT - trần cho số tiền cố định chỉ là một số tiền cố định nhỏ hơn. */
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

/** Port từ UpdatePromotionRequestDTO, không dùng `PartialType(CreatePromotionDto)`: rule có điều kiện đọc field khác có thể vắng khi update một phần, nên service kiểm lại trên kết quả đã gộp. */
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

/** Port từ PromotionQueryDTO (`recordPerPage` đổi thành `limit`, như các module khác). */
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

export class CartItemDto {
  @IsUUID()
  productItemId: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1, { message: 'Số lượng phải từ 1 trở lên' })
  quantity: number;

  // Không có `unitPrice`: giá lấy từ `ProductItem.retailPrice` phía server; mọi giá gửi lên đều bị whitelist toàn cục loại bỏ.
}

/** Port từ PromotionCalculateRequestDTO - payload dùng cho `/candidates`, `/calculate` và `/apply`. */
export class PriceCartDto {
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @IsOptional()
  @IsUUID()
  customerId?: string;

  /** Chỉ `/apply` cần - đơn mà mức giảm sẽ được ghi nhận vào. */
  @IsOptional()
  @IsUUID()
  orderId?: string;

  @IsArray()
  @ArrayNotEmpty({ message: 'Giỏ hàng phải có ít nhất một mặt hàng' })
  @ValidateNested({ each: true })
  @Type(() => CartItemDto)
  items: CartItemDto[];

  /** Đúng các khuyến mãi khách đã chọn. Rỗng là hợp lệ, nghĩa là không giảm giá. */
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  promotionIds?: string[];
}
