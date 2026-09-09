import { Module } from '@nestjs/common';
import { TicketController } from './tickets.controller';
import { AdminTicketController } from './admin-tickets.controller';
import { TicketService } from './tickets.service';
import { NotificationModule } from '../notifications/notifications.module';

// NotificationModule for both directions of a support thread: notifySystem() tells the operators a ticket was opened, notify()/tenantOwners() tells the shop it was answered.
@Module({
  imports: [NotificationModule],
  controllers: [TicketController, AdminTicketController],
  providers: [TicketService],
  exports: [TicketService],
})
export class TicketModule {}
