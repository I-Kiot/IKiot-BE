import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationService } from '../notifications/notifications.service';
import { LeaveRequestNotificationTemplates } from '../notifications/templates/leave-request.templates';
import { LeaveRequestStatus } from './leave-request.constants';
import { VIETNAM_TIMEZONE } from '../../common/constants/timezone';

/** Expires leave nobody got round to deciding on, daily at 00:01 Vietnam time: a PENDING request whose start date has passed is not a decision anyone can still make, and it should stop blocking overlapping requests. */
@Injectable()
export class LeaveRequestCronService {
  private readonly logger = new Logger(LeaveRequestCronService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
  ) {}

  @Cron('1 0 * * *', { timeZone: VIETNAM_TIMEZONE })
  async expireOverdueRequests(): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;

    // Loaded before the update, not after: once the status has changed there is no way to tell which rows this run touched, and each owner needs notifying.
    const overdue = await this.prisma.leaveRequest.findMany({
      where: {
        status: LeaveRequestStatus.PENDING,
        startDate: { lt: new Date() },
      },
      select: { id: true, userId: true, tenantId: true },
    });
    if (overdue.length === 0) return;

    const { count } = await this.prisma.leaveRequest.updateMany({
      where: { id: { in: overdue.map((request) => request.id) } },
      data: { status: LeaveRequestStatus.EXPIRED },
    });
    this.logger.log(`Expired ${count} overdue leave requests`);

    for (const request of overdue) {
      await this.notifications.notify({
        tenantId: request.tenantId,
        recipientIds: [request.userId],
        referenceId: request.id,
        ...LeaveRequestNotificationTemplates.expired(request.id),
      });
    }
  }
}
