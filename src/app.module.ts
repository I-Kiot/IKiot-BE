import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import {
  APP_FILTER,
  APP_GUARD,
  APP_INTERCEPTOR,
  DiscoveryModule,
} from '@nestjs/core';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { PermissionsGuard } from './common/guards/permissions.guard';
import { AuditInterceptor } from './common/interceptors/audit.interceptor';
import { ResponseEnvelopeInterceptor } from './common/interceptors/response-envelope.interceptor';
import { RealtimeModule } from './common/realtime/realtime.module';
import { RedisModule } from './common/redis/redis.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

import { AuthModule } from './modules/auth/auth.module';
import { RolesModule } from './modules/roles/roles.module';
import { AIChatHistoryModule } from './modules/ai-chat-histories/ai-chat-histories.module';
import { AttendanceModule } from './modules/attendances/attendances.module';
import { AuditLogModule } from './modules/audit-logs/audit-logs.module';
import { BranchModule } from './modules/branches/branches.module';
import { BrandModule } from './modules/brands/brands.module';
import { CashDrawerSessionModule } from './modules/cash-drawer-sessions/cash-drawer-sessions.module';
import { CashFlowModule } from './modules/cash-flows/cash-flows.module';
import { CategoryModule } from './modules/categories/categories.module';
import { CustomerModule } from './modules/customers/customers.module';
import { HolidayModule } from './modules/holidays/holidays.module';
import { InventoryModule } from './modules/inventories/inventories.module';
import { LeaveRequestModule } from './modules/leave-requests/leave-requests.module';
import { NotificationModule } from './modules/notifications/notifications.module';
import { OrderModule } from './modules/orders/orders.module';
import { PayrollPeriodModule } from './modules/payroll-periods/payroll-periods.module';
import { PayrollSettingModule } from './modules/payroll-settings/payroll-settings.module';
import { PaysheetModule } from './modules/paysheets/paysheets.module';
import { PayslipModule } from './modules/payslips/payslips.module';
import { PlanModule } from './modules/plans/plans.module';
import { ProductModule } from './modules/products/products.module';
import { PromotionModule } from './modules/promotions/promotions.module';
import { ShiftTemplateModule } from './modules/shift-templates/shift-templates.module';
import { StockMovementRequestModule } from './modules/stock-movement-requests/stock-movement-requests.module';
import { SubscriptionInvoiceModule } from './modules/subscription-invoices/subscription-invoices.module';
import { SubscriptionModule } from './modules/subscriptions/subscriptions.module';
import { SupplierModule } from './modules/suppliers/suppliers.module';
import { TenantModule } from './modules/tenants/tenants.module';
import { TicketModule } from './modules/tickets/tickets.module';
import { StatsModule } from './modules/stats/stats.module';
import { UploadModule } from './modules/uploads/uploads.module';
import { UserModule } from './modules/users/users.module';
import { WarehouseModule } from './modules/warehouses/warehouses.module';
import { WorkingScheduleModule } from './modules/working-schedules/working-schedules.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    // Lets AuditInterceptor find every @AuditTemplate() provider on its own.
    DiscoveryModule,
    PrismaModule,
    RedisModule,
    RealtimeModule,
    AuthModule,
    RolesModule,
    AIChatHistoryModule,
    AttendanceModule,
    AuditLogModule,
    BranchModule,
    BrandModule,
    CashDrawerSessionModule,
    CashFlowModule,
    CategoryModule,
    CustomerModule,
    HolidayModule,
    InventoryModule,
    LeaveRequestModule,
    NotificationModule,
    OrderModule,
    PayrollPeriodModule,
    PayrollSettingModule,
    PaysheetModule,
    PayslipModule,
    PlanModule,
    ProductModule,
    PromotionModule,
    ShiftTemplateModule,
    StockMovementRequestModule,
    SubscriptionInvoiceModule,
    SubscriptionModule,
    SupplierModule,
    TenantModule,
    TicketModule,
    StatsModule,
    UploadModule,
    UserModule,
    WarehouseModule,
    WorkingScheduleModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Order matters: JwtAuthGuard populates request.user before PermissionsGuard reads it.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    // Registered first so it wraps last: AuditInterceptor's tap must still see the raw login body it reads the actor from.
    { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
    // Domain audit descriptions come from @AuditTemplate() providers; this interceptor stays generic.
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
    // Last line of defence: turns Prisma and other non-HttpException errors into real status codes.
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
