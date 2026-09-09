import { Module } from '@nestjs/common';
import { AIChatHistoryController } from './ai-chat-histories.controller';
import { AIChatHistoryService } from './ai-chat-histories.service';
import { AiAgentService } from './ai-agent.service';
import { AiToolsService } from './ai-tools.service';
import { GeminiClient, GoogleGeminiClient } from './gemini.client';

import { ProductModule } from '../products/products.module';
import { CategoryModule } from '../categories/categories.module';
import { BrandModule } from '../brands/brands.module';
import { CustomerModule } from '../customers/customers.module';
import { BranchModule } from '../branches/branches.module';
import { WarehouseModule } from '../warehouses/warehouses.module';
import { SupplierModule } from '../suppliers/suppliers.module';
import { UserModule } from '../users/users.module';
import { AttendanceModule } from '../attendances/attendances.module';
import { LeaveRequestModule } from '../leave-requests/leave-requests.module';
import { WorkingScheduleModule } from '../working-schedules/working-schedules.module';
import { PaysheetModule } from '../paysheets/paysheets.module';
import { InventoryModule } from '../inventories/inventories.module';
import { OrderModule } from '../orders/orders.module';
import { PromotionModule } from '../promotions/promotions.module';
import { SubscriptionModule } from '../subscriptions/subscriptions.module';
import { StockMovementRequestModule } from '../stock-movement-requests/stock-movement-requests.module';
import { CashDrawerSessionModule } from '../cash-drawer-sessions/cash-drawer-sessions.module';
import { TicketModule } from '../tickets/tickets.module';
import { StatsModule } from '../stats/stats.module';

/** Imports twenty modules on purpose: the assistant reads the product through the services that own each question, so its numbers cannot drift from the dashboard's. `GeminiClient` is abstract so tests can script it. */
@Module({
  imports: [
    ProductModule,
    CategoryModule,
    BrandModule,
    CustomerModule,
    BranchModule,
    WarehouseModule,
    SupplierModule,
    UserModule,
    AttendanceModule,
    LeaveRequestModule,
    WorkingScheduleModule,
    PaysheetModule,
    InventoryModule,
    OrderModule,
    PromotionModule,
    SubscriptionModule,
    StockMovementRequestModule,
    CashDrawerSessionModule,
    TicketModule,
    StatsModule,
  ],
  controllers: [AIChatHistoryController],
  providers: [
    AIChatHistoryService,
    AiAgentService,
    AiToolsService,
    { provide: GeminiClient, useClass: GoogleGeminiClient },
  ],
  exports: [AIChatHistoryService],
})
export class AIChatHistoryModule {}
