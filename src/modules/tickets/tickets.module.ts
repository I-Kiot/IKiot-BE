import { Module } from '@nestjs/common';
import { TicketController } from './tickets.controller';
import { AdminTicketController } from './admin-tickets.controller';
import { TicketService } from './tickets.service';
import { NotificationModule } from '../notifications/notifications.module';

// NotificationModule cho cả hai chiều của thread: notifySystem() báo operator khi có ticket mới, notify()/tenantOwners() báo shop khi được trả lời.
@Module({
  imports: [NotificationModule],
  controllers: [TicketController, AdminTicketController],
  providers: [TicketService],
  exports: [TicketService],
})
export class TicketModule {}
