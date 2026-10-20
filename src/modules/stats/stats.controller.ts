import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { StatsService } from './stats.service';
import {
  CashflowListQueryDto,
  CashflowQueryDto,
  InventoryStatsQueryDto,
  OrderPipelineQueryDto,
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

/** The shop dashboard: read-only endpoints at the old paths, all behind `reports:read`. How much of the tenant each answer covers is decided by the caller's posting, not the query string - see `stats-scope.ts`. */
@ApiTags('stats')
@ApiBearerAuth('bearer')
@Controller('stats')
export class StatsController {
  constructor(private readonly service: StatsService) {}

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
  revenueByStaff(@CurrentUser() user: AuthUser, @Query() query: StatsQueryDto) {
    return this.service.getRevenueByStaff(user, query);
  }

  /** Declared before `cashflow` so the longer literal path is matched first. */
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

  /** Today / week / month / quarter / year, each against the same elapsed span of the period before. */
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

  /** Weekday x hour of the shop's local day - when the till is busy. */
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
}
