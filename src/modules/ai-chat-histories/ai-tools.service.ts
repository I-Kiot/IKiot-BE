import { Injectable, Logger } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PrismaService } from '../../prisma/prisma.service';
import { can } from '../../common/utils/permission';
import { requireTenantId } from '../../common/utils/tenant-scope';
import type { AuthUser } from '../../common/types/auth-user.type';

import { ProductService } from '../products/products.service';
import { CategoryService } from '../categories/categories.service';
import { BrandService } from '../brands/brands.service';
import { CustomerService } from '../customers/customers.service';
import { BranchService } from '../branches/branches.service';
import { WarehouseService } from '../warehouses/warehouses.service';
import { SupplierService } from '../suppliers/suppliers.service';
import { UserService } from '../users/users.service';
import { AttendanceService } from '../attendances/attendances.service';
import { LeaveRequestService } from '../leave-requests/leave-requests.service';
import { WorkingScheduleService } from '../working-schedules/working-schedules.service';
import { PaysheetService } from '../paysheets/paysheets.service';
import { InventoryService } from '../inventories/inventories.service';
import { OrderService } from '../orders/orders.service';
import { PromotionService } from '../promotions/promotions.service';
import { SubscriptionService } from '../subscriptions/subscriptions.service';
import { StockMovementService } from '../stock-movement-requests/stock-movement-requests.service';
import { CashDrawerSessionService } from '../cash-drawer-sessions/cash-drawer-sessions.service';
import { TicketService } from '../tickets/tickets.service';
import { StatsService } from '../stats/stats.service';

import {
  QueryProductDto,
  SearchProductDto,
} from '../products/dto/query-product.dto';
import { QueryCategoryDto } from '../categories/dto/query-category.dto';
import { QueryBrandDto } from '../brands/dto/query-brand.dto';
import { QueryCustomerDto } from '../customers/dto/customer.dto';
import { QuerySupplierDto } from '../suppliers/dto/query-supplier.dto';
import { QueryUserDto } from '../users/dto/query-user.dto';
import { QueryInventoryDto } from '../inventories/dto/query-inventory.dto';
import { QueryOrderDto } from '../orders/dto/order.dto';
import { QueryPromotionDto } from '../promotions/dto/promotion.dto';
import { QueryAttendanceDto } from '../attendances/dto/attendance.dto';
import { QueryLeaveRequestDto } from '../leave-requests/dto/leave-request.dto';
import { QueryWorkingScheduleDto } from '../working-schedules/dto/working-schedule.dto';
import { QueryPaysheetDto } from '../paysheets/dto/paysheet.dto';
import { QueryStockMovementDto } from '../stock-movement-requests/dto/stock-movement.dto';
import { QueryCashDrawerDto } from '../cash-drawer-sessions/dto/cash-drawer.dto';
import {
  CashflowListQueryDto,
  InventoryStatsQueryDto,
  RevenueSeriesQueryDto,
  StatsQueryDto,
  TopProductsQueryDto,
} from '../stats/dto/stats-query.dto';

type ToolArgs = Record<string, unknown>;
type Ctor<T> = new () => T;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every tool's required permission - the security boundary of the whole AI feature: the old implementation ran every tool as TENANT_OWNER, making the assistant a back door around every read rule. */
const TOOL_PERMISSIONS: Record<string, [resource: string, action: string]> = {
  searchProducts: ['products', 'read'],
  getProductStockLevel: ['products', 'read'],
  getProductCategories: ['categories', 'read'],
  getProductBrands: ['brands', 'read'],
  searchCustomers: ['customers', 'read'],
  getCustomerPurchaseHistory: ['customers', 'read'],
  getBranchList: ['branches', 'read'],
  getWarehouseList: ['warehouses', 'read'],
  getSupplierList: ['suppliers', 'read'],
  getStaffList: ['staff', 'read'],
  getStaffAttendanceReport: ['attendances', 'read'],
  getLeaveRequests: ['leaveRequests', 'read'],
  getStaffWorkingSchedule: ['schedules', 'read'],
  getPayrollSummary: ['paysheets', 'read'],
  getActivePromotions: ['promotions', 'read'],
  getTenantSubscriptionInfo: ['subscriptions', 'read'],
  getInventoryList: ['inventory', 'read'],
  searchOrders: ['orders', 'read'],
  getRecentOrders: ['orders', 'read'],
  getOrderDetailsByCode: ['orders', 'read'],
  getStockMovementHistory: ['stock_movement', 'read'],
  getRevenueOverview: ['reports', 'read'],
  getRevenueSeries: ['reports', 'read'],
  getRevenueByPaymentMethod: ['reports', 'read'],
  getRevenueByStaff: ['reports', 'read'],
  getTopProducts: ['reports', 'read'],
  getInventoryOverviewStats: ['reports', 'read'],
  getCashflowSummary: ['reports', 'read'],
  getCashDrawerSessions: ['cash_drawers', 'read'],
  getTenantTickets: ['tickets', 'read'],
};

/** The thirty read-only lookups the assistant can make: each delegates to the module that owns the question, and model arguments are coerced through the same DTO the REST endpoint validates. */
@Injectable()
export class AiToolsService {
  private readonly logger = new Logger(AiToolsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly products: ProductService,
    private readonly categories: CategoryService,
    private readonly brands: BrandService,
    private readonly customers: CustomerService,
    private readonly branches: BranchService,
    private readonly warehouses: WarehouseService,
    private readonly suppliers: SupplierService,
    private readonly users: UserService,
    private readonly attendances: AttendanceService,
    private readonly leaveRequests: LeaveRequestService,
    private readonly schedules: WorkingScheduleService,
    private readonly paysheets: PaysheetService,
    private readonly inventories: InventoryService,
    private readonly orders: OrderService,
    private readonly promotions: PromotionService,
    private readonly subscriptions: SubscriptionService,
    private readonly stockMovements: StockMovementService,
    private readonly cashDrawers: CashDrawerSessionService,
    private readonly tickets: TicketService,
    private readonly stats: StatsService,
  ) {}

  /** Run one tool call. Never throws - the loop needs a value to hand back either way, and "you have no permission" is something the model can usefully say. */
  async run(
    user: AuthUser,
    name: string,
    args: ToolArgs,
  ): Promise<{ result: unknown } | { error: string }> {
    const permission = TOOL_PERMISSIONS[name];
    if (!permission) return { error: `Tool ${name} is not defined.` };

    if (!can(user, permission[0], permission[1])) {
      return {
        error: `Bạn không có quyền ${permission[0]}:${permission[1]} để xem thông tin này.`,
      };
    }

    try {
      return { result: await this.dispatch(user, name, args) };
    } catch (error) {
      this.logger.warn(
        `Tool ${name} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        error:
          error instanceof Error ? error.message : 'Failed to execute tool.',
      };
    }
  }

  private async dispatch(user: AuthUser, name: string, args: ToolArgs) {
    const tenantId = requireTenantId(user);

    switch (name) {
      // ─── Catalogue ───────────────────────────────────────────────────────
      case 'searchProducts':
        return this.products.findAll(
          tenantId,
          await this.dto(QueryProductDto, args),
        );

      case 'getProductStockLevel': {
        const id = await this.resolveProductId(
          tenantId,
          this.str(args.productId),
        );
        return this.products.findOne(tenantId, id, {});
      }

      case 'getProductCategories':
        return this.categories.findAll(
          tenantId,
          await this.dto(QueryCategoryDto, args),
        );

      case 'getProductBrands':
        return this.brands.findAll(
          tenantId,
          await this.dto(QueryBrandDto, args),
        );

      case 'getInventoryList':
        return this.inventories.findAll(
          tenantId,
          await this.dto(QueryInventoryDto, args),
        );

      // ─── Customers ───────────────────────────────────────────────────────
      case 'searchCustomers':
        return this.customers.findAll(
          tenantId,
          await this.dto(QueryCustomerDto, args),
        );

      case 'getCustomerPurchaseHistory': {
        const customerId = await this.resolveCustomerId(
          tenantId,
          this.str(args.customerId),
        );
        const customer = await this.customers.findOne(tenantId, customerId);
        // Orders go through OrderService so the caller's posting narrows them, exactly as on `GET /orders`.
        const history = await this.orders.findAll(
          user,
          tenantId,
          await this.dto(QueryOrderDto, { customerId, page: 1, limit: 20 }),
        );
        return {
          customer,
          purchaseHistory: history.data,
          totalOrders: history.pagination.total,
          totalSpent: history.data.reduce(
            (sum, order) => sum + Number(order.grandTotal ?? 0),
            0,
          ),
        };
      }

      // ─── Org ─────────────────────────────────────────────────────────────
      case 'getBranchList':
        return this.branches.findAll(tenantId, this.locationQuery(args));

      case 'getWarehouseList':
        return this.warehouses.findAll(tenantId, this.locationQuery(args));

      case 'getSupplierList':
        return this.suppliers.findAll(
          tenantId,
          await this.dto(QuerySupplierDto, args),
        );

      // ─── People ──────────────────────────────────────────────────────────
      case 'getStaffList':
        return this.users.findAll(
          tenantId,
          user.userId,
          await this.dto(QueryUserDto, args),
        );

      case 'getStaffAttendanceReport':
        return this.attendances.findAll(
          user,
          await this.dto(QueryAttendanceDto, args),
        );

      case 'getLeaveRequests':
        return this.leaveRequests.findAll(
          user,
          await this.dto(QueryLeaveRequestDto, args),
        );

      case 'getStaffWorkingSchedule':
        return this.schedules.findAll(
          tenantId,
          await this.dto(QueryWorkingScheduleDto, args),
        );

      case 'getPayrollSummary':
        return this.paysheets.findAll(
          tenantId,
          await this.dto(QueryPaysheetDto, args),
        );

      // ─── Selling ─────────────────────────────────────────────────────────
      case 'searchOrders':
        return this.orders.findAll(
          user,
          tenantId,
          await this.dto(QueryOrderDto, args),
        );

      case 'getRecentOrders':
        return this.orders.findAll(
          user,
          tenantId,
          await this.dto(QueryOrderDto, { page: 1, limit: args.limit ?? 10 }),
        );

      case 'getOrderDetailsByCode': {
        const id = await this.resolveOrderId(
          tenantId,
          this.str(args.orderCode),
        );
        return this.orders.findOne(user, tenantId, id);
      }

      case 'getActivePromotions':
        return this.promotions.findAll(
          user,
          tenantId,
          await this.dto(QueryPromotionDto, { ...args, status: 'ACTIVE' }),
        );

      case 'getCashDrawerSessions':
        return this.cashDrawers.findAll(
          user,
          await this.dto(QueryCashDrawerDto, args),
        );

      case 'getStockMovementHistory':
        return this.stockMovements.findAll(
          user,
          await this.dto(QueryStockMovementDto, args),
        );

      // ─── Reporting ───────────────────────────────────────────────────────
      case 'getRevenueOverview':
        return this.stats.getOverview(
          user,
          await this.dto(StatsQueryDto, this.withMonthToDate(args)),
        );

      case 'getRevenueSeries':
        return this.stats.getRevenueSeries(
          user,
          await this.dto(RevenueSeriesQueryDto, this.withMonthToDate(args)),
        );

      case 'getRevenueByPaymentMethod':
        return this.stats.getRevenueByPaymentMethod(
          user,
          await this.dto(StatsQueryDto, this.withMonthToDate(args)),
        );

      case 'getRevenueByStaff':
        return this.stats.getRevenueByStaff(
          user,
          await this.dto(StatsQueryDto, this.withMonthToDate(args)),
        );

      case 'getTopProducts':
        return this.stats.getTopProducts(
          user,
          await this.dto(TopProductsQueryDto, this.withMonthToDate(args)),
        );

      case 'getInventoryOverviewStats':
        return this.stats.getInventory(
          user,
          await this.dto(InventoryStatsQueryDto, args),
        );

      case 'getCashflowSummary': {
        const query = await this.dto(
          CashflowListQueryDto,
          this.withMonthToDate(args),
        );
        const [summary, list] = await Promise.all([
          this.stats.getCashflow(user, query),
          this.stats.getCashflowList(user, query),
        ]);
        return {
          summary,
          recentTransactions: list.data,
          pagination: list.pagination,
        };
      }

      // ─── Housekeeping ────────────────────────────────────────────────────
      case 'getTenantSubscriptionInfo':
        return this.subscriptions.checkTrialStatus(tenantId);

      case 'getTenantTickets': {
        // TicketService has no filtered list, so the tool narrows the result itself rather than adding a route nothing else needs.
        const all = await this.tickets.findMine(tenantId);
        const status = this.str(args.status, false);
        const filtered = status
          ? all.filter((ticket) => ticket.status === status.toUpperCase())
          : all;
        const page = this.int(args.page, 1);
        const limit = this.int(args.limit, 10);
        const start = (page - 1) * limit;
        return {
          data: filtered.slice(start, start + limit),
          pagination: {
            total: filtered.length,
            page,
            limit,
            totalPages: Math.ceil(filtered.length / limit),
          },
        };
      }

      default:
        throw new Error(`Tool ${name} is not defined.`);
    }
  }

  // ─── Argument handling ─────────────────────────────────────────────────────

  /** Model output -> a validated DTO instance, using the same class the HTTP layer validates, so a tool can never be looser than its endpoint. */
  private async dto<T extends object>(
    ctor: Ctor<T>,
    args: ToolArgs,
  ): Promise<T> {
    const instance = plainToInstance(ctor, args, {
      enableImplicitConversion: true,
    });
    const errors = await validate(instance, {
      skipMissingProperties: true,
      forbidUnknownValues: false,
    });
    if (errors.length > 0) {
      const detail = errors
        .map((e) => Object.values(e.constraints ?? {}).join(', '))
        .filter(Boolean)
        .join('; ');
      throw new Error(`Tham số không hợp lệ: ${detail || 'không rõ'}`);
    }
    return instance;
  }

  /** Branches and warehouses take a plain paginated search, not a generated DTO. */
  private locationQuery(args: ToolArgs) {
    return {
      search: this.str(args.search, false),
      page: this.int(args.page, 1),
      limit: this.int(args.limit, 100),
    };
  }

  /** Reports default to month-to-date rather than the stats module's rolling 30 days: "doanh thu tháng này" is the question people actually ask an assistant. */
  private withMonthToDate(args: ToolArgs): ToolArgs {
    if (args.fromDate && args.toDate) return args;
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    return {
      ...args,
      fromDate: args.fromDate ?? monthStart.toISOString(),
      toDate: args.toDate ?? now.toISOString(),
    };
  }

  private str(value: unknown, required = true): string {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (!required) return '';
    throw new Error('Thiếu tham số bắt buộc');
  }

  private int(value: unknown, fallback: number): number {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  }

  // ─── Fuzzy id resolution ───────────────────────────────────────────────────
  // The model is handed names and codes rather than uuids, so each of these accepts either.

  private async resolveProductId(tenantId: string, term: string) {
    if (UUID.test(term)) return term;
    const found = await this.products.search(
      tenantId,
      await this.dto(SearchProductDto, { q: term, page: 1, limit: 1 }),
    );
    const first = found.data[0];
    if (!first) throw new Error(`Không tìm thấy sản phẩm: ${term}`);
    return first.id;
  }

  private async resolveCustomerId(tenantId: string, term: string) {
    if (UUID.test(term)) return term;
    const found = await this.customers.findAll(
      tenantId,
      await this.dto(QueryCustomerDto, { search: term, page: 1, limit: 1 }),
    );
    const first = found.data[0];
    if (!first) throw new Error(`Không tìm thấy khách hàng: ${term}`);
    return first.id;
  }

  /** An order code (`paymentReference`) is unique across every tenant, so the tenant filter here is what stops one shop reading another's order by guessing a code. */
  private async resolveOrderId(tenantId: string, term: string) {
    if (UUID.test(term)) return term;
    const order = await this.prisma.order.findFirst({
      where: {
        tenantId,
        paymentReference: { equals: term, mode: 'insensitive' },
      },
      select: { id: true },
    });
    if (!order) throw new Error(`Không tìm thấy đơn hàng với mã: ${term}`);
    return order.id;
  }
}
