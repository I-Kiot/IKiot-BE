import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { StatsService } from './stats.service';
import {
  CashflowListQueryDto,
  CashflowQueryDto,
  InventoryStatsQueryDto,
  RevenueSeriesQueryDto,
  StatsQueryDto,
  TopProductsQueryDto,
} from './dto/stats-query.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import type { AuthUser } from '../../common/types/auth-user.type';

/** The shop dashboard: eight read-only endpoints at the old paths, all behind `reports:read`. How much of the tenant each answer covers is decided by the caller's posting, not the query string - see `stats-scope.ts`. */
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
}
