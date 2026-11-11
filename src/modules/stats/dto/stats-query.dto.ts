import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  Min,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { CASHFLOW_PREFIXES } from '../../../common/utils/reference-generator';
import { PAYMENT_METHODS } from '../../../common/constants/payment-method';
import {
  CASH_FLOW_CATEGORIES,
  CASH_FLOW_FUNDS,
} from '../../../common/constants/cash-flow-category';
import { SalesJournalEntryType } from '../../../common/constants/sales-journal';
import {
  ADMIN_GROUP_BY_VALUES,
  DEFAULT_LOW_STOCK_THRESHOLD,
  FLOW_TYPES,
  GROUP_BY_VALUES,
  GroupBy,
  TOP_PRODUCTS_SORTS,
  TopProductsSort,
} from '../stats.constants';
import { resolveRange, type DateRange } from '../stats-math';

const upper = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toUpperCase() : value,
  );

/** `fromDate` không được sau `toDate`. Validator cho cả khoảng chứ không từng trường, vì từng đầu mút riêng đều hợp lệ. So sánh qua `resolveRange` (cùng cách query parse): `new Date('2026-10-21')` là nửa đêm UTC = 07:00 giờ VN, nên “hôm nay đến bây giờ” gửi lúc 00:00–07:00 từng bị báo ngược. */
@ValidatorConstraint({ name: 'rangeIsForwards' })
class RangeIsForwards implements ValidatorConstraintInterface {
  validate(_: unknown, args: ValidationArguments): boolean {
    const { fromDate, toDate } = args.object as StatsQueryDto;
    if (!fromDate || !toDate) return true;
    const range = resolveRange(fromDate, toDate);
    return range.fromDate.getTime() <= range.toDate.getTime();
  }
  defaultMessage(): string {
    return 'fromDate phải trước toDate';
  }
}

/** Query dùng chung cho mọi endpoint dashboard, tách theo route để mỗi route chỉ nhận phần nó đọc (DTO gộp cũ làm `?sortBy=` bị bỏ qua lặng lẽ ở `/stats/overview`). Hai đầu nhận ISO timestamp đầy đủ hoặc `YYYY-MM-DD` (ngày địa phương); cắt `toDate` về nửa đêm sẽ mất một ngày bán hàng. */
export class StatsQueryDto {
  @IsOptional()
  @IsISO8601({ strict: false }, { message: 'fromDate không hợp lệ' })
  @Validate(RangeIsForwards)
  fromDate?: string;

  @IsOptional()
  @IsISO8601({ strict: false }, { message: 'toDate không hợp lệ' })
  toDate?: string;

  @IsOptional()
  @IsString()
  branchId?: string;

  /** Khoảng đã áp mặc định - gọi hàm này thay vì đọc hai chuỗi thô. */
  range(): DateRange {
    return resolveRange(this.fromDate, this.toDate);
  }
}

export class RevenueSeriesQueryDto extends StatsQueryDto {
  @IsOptional()
  @IsIn(GROUP_BY_VALUES, {
    message: `groupBy phải là ${GROUP_BY_VALUES.join(' hoặc ')}`,
  })
  groupBy?: GroupBy = GroupBy.DAY;
}

/** Endpoint dòng tiền thêm bộ lọc kho - tiền cũng đi qua kho, còn bán hàng thì không. */
export class CashflowQueryDto extends StatsQueryDto {
  @IsOptional()
  @IsString()
  warehouseId?: string;

  @IsOptional()
  @upper()
  @IsIn(CASHFLOW_PREFIXES, {
    message: `flow phải là ${CASHFLOW_PREFIXES.join(', ')}`,
  })
  flow?: string;

  @IsOptional()
  @upper()
  @IsIn(FLOW_TYPES, {
    message: `flowType phải là ${FLOW_TYPES.join(' hoặc ')}`,
  })
  flowType?: string;

  /** Loại tiền (`cash_flows.category`). */
  @IsOptional()
  @upper()
  @IsIn(CASH_FLOW_CATEGORIES, {
    message: `category phải là ${CASH_FLOW_CATEGORIES.join(', ')}`,
  })
  category?: string;

  /** Quỹ nơi tiền nằm (`cash_flows.fund`): DRAWER | OWNER | BANK. */
  @IsOptional()
  @upper()
  @IsIn(CASH_FLOW_FUNDS, {
    message: `fund phải là ${CASH_FLOW_FUNDS.join(', ')}`,
  })
  fund?: string;
}

export class CashflowListQueryDto extends CashflowQueryDto {
  @IsOptional()
  @upper()
  @IsIn(PAYMENT_METHODS, {
    message: `paymentMethod phải là ${PAYMENT_METHODS.join(', ')}`,
  })
  paymentMethod?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 10;
}

export const STAFF_GROUP_BY_VALUES: readonly string[] = [
  'assignee',
  'creator',
  'collector',
];

/** `/stats/revenue-by-staff`: doanh thu gắn với ai. */
export class RevenueByStaffQueryDto extends StatsQueryDto {
  /** assignee (mặc định, người phụ trách), creator (người lên đơn) hoặc collector (người thu tiền, theo tiền thực thu). */
  @IsOptional()
  @IsIn(STAFF_GROUP_BY_VALUES, {
    message: `groupBy phải là ${STAFF_GROUP_BY_VALUES.join(', ')}`,
  })
  groupBy: string = 'assignee';
}

/** `/stats/sales-journal`: đọc thẳng các bút toán doanh thu. Khoảng ngày lọc theo `business_date` (ngày địa phương), không theo giờ. */
export class SalesJournalQueryDto extends StatsQueryDto {
  @IsOptional()
  @upper()
  @IsIn(Object.values(SalesJournalEntryType), {
    message: `entryType phải là ${Object.values(SalesJournalEntryType).join(', ')}`,
  })
  entryType?: string;

  @IsOptional()
  @IsString()
  orderId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}

export class TopProductsQueryDto extends StatsQueryDto {
  @IsOptional()
  @IsIn(TOP_PRODUCTS_SORTS, {
    message: `sortBy phải là ${TOP_PRODUCTS_SORTS.join(' hoặc ')}`,
  })
  sortBy?: string = TopProductsSort.QUANTITY;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 10;
}

export class TopCustomersQueryDto extends StatsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit: number = 5;
}

/** Chỉ có bộ lọc địa điểm: các mốc so sánh là mốc lịch cố định, không phải khoảng do người gọi chọn. */
export class RevenueComparisonQueryDto {
  @IsOptional()
  @IsString()
  branchId?: string;
}

/** Không có khoảng ngày: tồn kho là mức tại một thời điểm, không phải luồng - luôn là "ngay bây giờ". */
export class InventoryStatsQueryDto {
  @IsOptional()
  @IsString()
  branchId?: string;

  @IsOptional()
  @IsString()
  warehouseId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  lowStockThreshold: number = DEFAULT_LOW_STOCK_THRESHOLD;
}

/** Cảnh báo tồn kho: như `/stats/inventory`, là mức tồn "ngay lúc này" nên không có khoảng ngày. */
export class StockAlertsQueryDto extends InventoryStatsQueryDto {}

/** Tình trạng đơn đang chạy: đếm tại thời điểm gọi, không theo kỳ - một đơn chờ xác nhận từ tuần trước vẫn đang chờ. */
export class OrderPipelineQueryDto {
  @IsOptional()
  @IsString()
  branchId?: string;
}

export class SlowProductsQueryDto extends StatsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit: number = 5;
}

/** Tổng quan nền tảng nhìn xuyên tenant nên không có bộ lọc địa điểm. */
export class AdminOverviewQueryDto {
  @IsOptional()
  @IsISO8601({ strict: false }, { message: 'fromDate không hợp lệ' })
  fromDate?: string;

  @IsOptional()
  @IsISO8601({ strict: false }, { message: 'toDate không hợp lệ' })
  toDate?: string;

  @IsOptional()
  @IsIn(ADMIN_GROUP_BY_VALUES, {
    message: `groupBy phải là ${ADMIN_GROUP_BY_VALUES.join(' hoặc ')}`,
  })
  groupBy?: GroupBy = GroupBy.DAY;

  range(): DateRange {
    return resolveRange(this.fromDate, this.toDate);
  }
}
