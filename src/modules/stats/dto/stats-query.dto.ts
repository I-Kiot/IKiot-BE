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

/** Kiểm `fromDate` không sau `toDate`. */
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

/** Query dùng chung cho các endpoint dashboard. */
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
  'seller',
  'assignee',
  'creator',
  'collector',
];

/** `/stats/revenue-by-staff`: doanh thu gắn với ai. */
export class RevenueByStaffQueryDto extends StatsQueryDto {
  /** Gom doanh thu theo nhân viên bán hàng, người phụ trách, người lên đơn hoặc người thu tiền. */
  @IsOptional()
  @IsIn(STAFF_GROUP_BY_VALUES, {
    message: `groupBy phải là ${STAFF_GROUP_BY_VALUES.join(', ')}`,
  })
  groupBy: string = 'seller';

  /** Trang (từ 1), chỉ phân trang khi có `limit`. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

/** Giá trị `userId` cho phần doanh thu không gắn nhân viên. */
export const NO_STAFF_ID = 'none';

/** `/stats/revenue-by-staff/entries`: từng bút toán / khoản thu tạo nên một dòng của báo cáo nhân viên. */
export class RevenueByStaffEntriesQueryDto extends StatsQueryDto {
  @IsOptional()
  @IsIn(STAFF_GROUP_BY_VALUES, {
    message: `groupBy phải là ${STAFF_GROUP_BY_VALUES.join(', ')}`,
  })
  groupBy: string = 'seller';

  /** Id nhân viên, hoặc `none` cho phần không gắn nhân viên. */
  @IsString()
  userId!: string;

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
  limit: number = 50;
}

/** `/stats/revenue-by-branch`: cùng cách phân trang tuỳ chọn như theo nhân viên. */
export class RevenueByBranchQueryDto extends StatsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

/** Các báo cáo của trang Báo cáo, mỗi mục một tab; dùng cho `section` của file xuất. */
export const REPORT_SECTIONS: readonly string[] = [
  'result',
  'time',
  'product',
  'branch',
  'staff',
  'customer',
  'orders',
  'cash',
  'inventory',
];

/** Bộ lọc sổ doanh thu, lọc theo `business_date`. */
export class SalesJournalExportQueryDto extends StatsQueryDto {
  @IsOptional()
  @upper()
  @IsIn(Object.values(SalesJournalEntryType), {
    message: `entryType phải là ${Object.values(SalesJournalEntryType).join(', ')}`,
  })
  entryType?: string;

  @IsOptional()
  @IsString()
  orderId?: string;
}

/** `/stats/sales-journal`: đọc thẳng các bút toán doanh thu, phân trang. */
export class SalesJournalQueryDto extends SalesJournalExportQueryDto {
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

/** Query xuất file báo cáo chi tiết. */
export class ReportExportQueryDto extends StatsQueryDto {
  @IsOptional()
  @IsString()
  warehouseId?: string;

  /** Mốc của sheet doanh thu theo thời gian: ngày (mặc định) hoặc tháng, như trang đang hiện. */
  @IsOptional()
  @IsIn(ADMIN_GROUP_BY_VALUES, {
    message: `groupBy phải là ${ADMIN_GROUP_BY_VALUES.join(' hoặc ')}`,
  })
  groupBy?: GroupBy = GroupBy.DAY;

  /** Chỉ xuất một báo cáo (một tab của trang); bỏ trống là xuất tất cả. */
  @IsOptional()
  @IsIn(REPORT_SECTIONS, {
    message: `section phải là ${REPORT_SECTIONS.join(', ')}`,
  })
  section?: string;

  /** Cách tính người của báo cáo theo nhân viên, như ô chọn trên trang. */
  @IsOptional()
  @IsIn(STAFF_GROUP_BY_VALUES, {
    message: `staffGroupBy phải là ${STAFF_GROUP_BY_VALUES.join(', ')}`,
  })
  staffGroupBy: string = 'seller';

  /** Ngưỡng "sắp hết" của báo cáo tồn kho, như ô chọn trên trang. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  lowStockThreshold: number = DEFAULT_LOW_STOCK_THRESHOLD;
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

/** Đếm tình trạng đơn tại thời điểm gọi. */
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
