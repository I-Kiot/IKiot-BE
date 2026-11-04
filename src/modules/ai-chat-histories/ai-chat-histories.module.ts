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
import { WorkingScheduleModule } from '../working-schedules/working-schedules.module';
import { InventoryModule } from '../inventories/inventories.module';
import { OrderModule } from '../orders/orders.module';
import { PromotionModule } from '../promotions/promotions.module';
import { SubscriptionModule } from '../subscriptions/subscriptions.module';
import { StockMovementRequestModule } from '../stock-movement-requests/stock-movement-requests.module';
import { CashDrawerSessionModule } from '../cash-drawer-sessions/cash-drawer-sessions.module';
import { TicketModule } from '../tickets/tickets.module';
import { StatsModule } from '../stats/stats.module';

/** Import 17 module có chủ đích: trợ lý đọc dữ liệu qua chính các service sở hữu từng câu hỏi, nên số liệu không lệch với dashboard. `GeminiClient` là abstract để test có thể giả lập. */
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
    WorkingScheduleModule,
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
