import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { StatsService } from './stats.service';
import { StatsReportsService } from './stats-reports.service';
import {
  CashflowListQueryDto,
  CashflowQueryDto,
  InventoryStatsQueryDto,
  OrderPipelineQueryDto,
  RevenueByStaffQueryDto,
  SalesJournalQueryDto,
  RevenueComparisonQueryDto,
  RevenueSeriesQueryDto,
  SlowProductsQueryDto,
  StatsQueryDto,
  StockAlertsQueryDto,
  TopCustomersQueryDto,
  TopProductsQueryDto,
} from './dto/stats-query.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import type { AuthUser } from '../../common/types/auth-user.type';

/** Dashboard shop: endpoint chỉ đọc, giữ đường dẫn cũ, đều yêu cầu `reports:read`. Phạm vi dữ liệu do quyền gắn của người gọi quyết định, không phải query string - xem `stats-scope.ts`. */
@ApiTags('stats')
@ApiBearerAuth('bearer')
@Controller('stats')
export class StatsController {
  constructor(
    private readonly service: StatsService,
    private readonly reports: StatsReportsService,
  ) {}

  @Permissions('reports', 'read')
  @Get('overview')
  overview(@CurrentUser() user: AuthUser, @Query() query: StatsQueryDto) {
    return this.service.getOverview(user, query);
  }

  @Permissions('reports', 'read')
  @Get('revenue')
  revenue(
    @CurrentUser() user: AuthUser,
    @Query() query: RevenueSeriesQueryDto,
  ) {
    return this.service.getRevenueSeries(user, query);
  }

  @Permissions('reports', 'read')
  @Get('revenue-by-payment-method')
  revenueByPaymentMethod(
    @CurrentUser() user: AuthUser,
    @Query() query: StatsQueryDto,
  ) {
    return this.service.getRevenueByPaymentMethod(user, query);
  }

  @Permissions('reports', 'read')
  @Get('revenue-by-staff')
  revenueByStaff(
    @CurrentUser() user: AuthUser,
    @Query() query: RevenueByStaffQueryDto,
  ) {
    return this.service.getRevenueByStaff(user, query);
  }

  /** Khai báo trước `cashflow` để route literal dài hơn khớp trước. */
  @Permissions('reports', 'read')
  @Get('cashflow/transactions')
  cashflowTransactions(
    @CurrentUser() user: AuthUser,
    @Query() query: CashflowListQueryDto,
  ) {
    return this.service.getCashflowList(user, query);
  }

  @Permissions('reports', 'read')
  @Get('cashflow')
  cashflow(@CurrentUser() user: AuthUser, @Query() query: CashflowQueryDto) {
    return this.service.getCashflow(user, query);
  }

  @Permissions('reports', 'read')
  @Get('top-products')
  topProducts(
    @CurrentUser() user: AuthUser,
    @Query() query: TopProductsQueryDto,
  ) {
    return this.service.getTopProducts(user, query);
  }

  @Permissions('reports', 'read')
  @Get('inventory')
  inventory(
    @CurrentUser() user: AuthUser,
    @Query() query: InventoryStatsQueryDto,
  ) {
    return this.service.getInventory(user, query);
  }

  /** Hôm nay / tuần / tháng / quý / năm, mỗi mốc so với cùng khoảng đã trôi qua của kỳ trước. */
  @Permissions('reports', 'read')
  @Get('revenue-comparison')
  revenueComparison(
    @CurrentUser() user: AuthUser,
    @Query() query: RevenueComparisonQueryDto,
  ) {
    return this.service.getRevenueComparison(user, query);
  }

  @Permissions('reports', 'read')
  @Get('orders-by-status')
  ordersByStatus(@CurrentUser() user: AuthUser, @Query() query: StatsQueryDto) {
    return this.service.getOrdersByStatus(user, query);
  }

  @Permissions('reports', 'read')
  @Get('revenue-by-branch')
  revenueByBranch(
    @CurrentUser() user: AuthUser,
    @Query() query: StatsQueryDto,
  ) {
    return this.service.getRevenueByBranch(user, query);
  }

  /** Thứ trong tuần x giờ trong ngày địa phương của shop - lúc quầy đông khách. */
  @Permissions('reports', 'read')
  @Get('sales-heatmap')
  salesHeatmap(@CurrentUser() user: AuthUser, @Query() query: StatsQueryDto) {
    return this.service.getSalesHeatmap(user, query);
  }

  @Permissions('reports', 'read')
  @Get('top-customers')
  topCustomers(
    @CurrentUser() user: AuthUser,
    @Query() query: TopCustomersQueryDto,
  ) {
    return this.service.getTopCustomers(user, query);
  }

  /** Hàng bán chậm: còn trên kệ nhưng bán ít nhất trong kỳ. */
  @Permissions('reports', 'read')
  @Get('slow-products')
  slowProducts(
    @CurrentUser() user: AuthUser,
    @Query() query: SlowProductsQueryDto,
  ) {
    return this.service.getSlowProducts(user, query);
  }

  /** Hết hàng, sắp hết, dưới mức tối thiểu, lâu không bán - mức tồn lúc gọi, không theo kỳ. */
  @Permissions('reports', 'read')
  @Get('stock-alerts')
  stockAlerts(
    @CurrentUser() user: AuthUser,
    @Query() query: StockAlertsQueryDto,
  ) {
    return this.service.getStockAlerts(user, query);
  }

  /** Đơn đang chạy theo từng bước hành trình, đếm tại thời điểm gọi. */
  @Permissions('reports', 'read')
  @Get('order-pipeline')
  orderPipeline(
    @CurrentUser() user: AuthUser,
    @Query() query: OrderPipelineQueryDto,
  ) {
    return this.service.getOrderPipeline(user, query);
  }

  /** Các bút toán doanh thu nguyên bản (SALE / RETURN / OTHER_INCOME) kèm dòng, phân trang: nền cho báo cáo kế toán. Khoảng ngày theo `business_date`. */
  @Permissions('reports', 'read')
  @Get('sales-journal')
  salesJournal(
    @CurrentUser() user: AuthUser,
    @Query() query: SalesJournalQueryDto,
  ) {
    return this.reports.getSalesJournal(user, query);
  }

  /** Tiền chưa khớp tại lúc gọi: tiền shipper đang giữ, giao dịch SePay chưa xử lý, đơn trả dư, tiền chưa gắn đơn, quỹ chủ, tiền mặt quầy kho, hoàn tiền mặt từ két. */
  @Permissions('reports', 'read')
  @Get('unreconciled')
  unreconciled(
    @CurrentUser() user: AuthUser,
    @Query() query: OrderPipelineQueryDto,
  ) {
    return this.reports.getUnreconciled(user, query.branchId);
  }
}
