import { Controller, Get, Query, StreamableFile } from '@nestjs/common';
import { ApiBearerAuth, ApiProduces, ApiTags } from '@nestjs/swagger';
import { StatsService } from './stats.service';
import { StatsReportsService } from './stats-reports.service';
import {
  StatsExportService,
  type ExportedFile,
} from './export/stats-export.service';
import { XLSX_MIME } from '../products/import/product-import.service';
import {
  CashflowListQueryDto,
  CashflowQueryDto,
  InventoryStatsQueryDto,
  OrderPipelineQueryDto,
  ReportExportQueryDto,
  RevenueByStaffQueryDto,
  RevenueByBranchQueryDto,
  SalesJournalExportQueryDto,
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

/** Dashboard shop, cần `reports:read`. */
@ApiTags('stats')
@ApiBearerAuth('bearer')
@Controller('stats')
export class StatsController {
  constructor(
    private readonly service: StatsService,
    private readonly reports: StatsReportsService,
    private readonly exporter: StatsExportService,
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
    @Query() query: RevenueByBranchQueryDto,
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

  /** Bút toán doanh thu kèm dòng, phân trang. */
  @Permissions('reports', 'read')
  @Get('sales-journal')
  salesJournal(
    @CurrentUser() user: AuthUser,
    @Query() query: SalesJournalQueryDto,
  ) {
    return this.reports.getSalesJournal(user, query);
  }

  /** Tiền chưa khớp tại lúc gọi. */
  @Permissions('reports', 'read')
  @Get('unreconciled')
  unreconciled(
    @CurrentUser() user: AuthUser,
    @Query() query: OrderPipelineQueryDto,
  ) {
    return this.reports.getUnreconciled(user, query.branchId);
  }

  /** File Excel của trang Báo cáo chi tiết: mỗi nhóm số liệu một sheet, cùng kỳ và địa điểm đang xem. */
  @Permissions('reports', 'read')
  @Get('export/report')
  @ApiProduces(XLSX_MIME)
  async exportReport(
    @CurrentUser() user: AuthUser,
    @Query() query: ReportExportQueryDto,
  ) {
    return xlsxFile(await this.exporter.report(user, query));
  }

  /** Sổ doanh thu cả kỳ dạng bảng như trên trang: sheet bút toán và sheet dòng hàng. */
  @Permissions('reports', 'read')
  @Get('export/sales-journal')
  @ApiProduces(XLSX_MIME)
  async exportSalesJournal(
    @CurrentUser() user: AuthUser,
    @Query() query: SalesJournalExportQueryDto,
  ) {
    return xlsxFile(await this.exporter.salesJournal(user, query));
  }

  /** Báo cáo đối soát tiền tại thời điểm gọi. */
  @Permissions('reports', 'read')
  @Get('export/unreconciled')
  @ApiProduces(XLSX_MIME)
  async exportUnreconciled(
    @CurrentUser() user: AuthUser,
    @Query() query: OrderPipelineQueryDto,
  ) {
    return xlsxFile(await this.exporter.unreconciled(user, query.branchId));
  }
}

function xlsxFile({ buffer, filename }: ExportedFile): StreamableFile {
  return new StreamableFile(buffer, {
    type: XLSX_MIME,
    disposition: `attachment; filename="${filename}"`,
  });
}
