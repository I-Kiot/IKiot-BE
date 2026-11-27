import { Module } from '@nestjs/common';
import { TicketController } from './tickets.controller';
import { AdminTicketController } from './admin-tickets.controller';
import { TicketService } from './tickets.service';
import { NotificationModule } from '../notifications/notifications.module';

// Thông báo hai chiều của ticket.
@Module({
  imports: [NotificationModule],
  controllers: [TicketController, AdminTicketController],
  providers: [TicketService],
  exports: [TicketService],
})
export class TicketModule {}
