import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationService } from '../notifications/notifications.service';
import { CashDrawerNotificationTemplates } from '../notifications/templates/cash-drawer.templates';
import { VIETNAM_TIMEZONE } from '../../common/constants/timezone';
import {
  BRANCH_NAME_SELECT,
  namedBranch,
} from '../../common/dto/location-ref.dto';
import { CashDrawerStatus } from './cash-drawer.constants';
import { isOverdue } from './session-window';

/**
 * Nhắc buổi sáng về két quên chốt. Chốt két vẫn phải do người đếm tiền làm, nên cron không chốt hộ - nó chỉ báo
 * cho quản lý chi nhánh (manager của địa điểm, không có thì chủ shop) mỗi sáng cho tới khi két được chốt.
 */
@Injectable()
export class CashDrawerCronService {
  private readonly logger = new Logger(CashDrawerCronService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
  ) {}

  // 07:00 giờ Việt Nam, trước giờ mở cửa: quản lý biết két hôm qua chưa chốt trước khi ca mới cần mở két.
  @Cron('0 7 * * *', { timeZone: VIETNAM_TIMEZONE })
  async runDailyJob() {
    if (process.env.NODE_ENV === 'test') return;
    try {
      const notified = await this.notifyOverdue();
      this.logger.log(`Overdue cash drawers reminded: ${notified}`);
    } catch (error) {
      this.logger.error(
        'Unhandled error in overdue cash drawer job',
        error instanceof Error ? error.stack : error,
      );
    }
  }

  /** Trả về số két đã nhắc. Tách khỏi `runDailyJob` để gọi được trong test mà không phụ thuộc `NODE_ENV`. */
  async notifyOverdue(now: Date = new Date()): Promise<number> {
    // Tối đa một phiên OPEN mỗi chi nhánh, nên tập này nhỏ; lọc bằng `isOverdue` thay vì viết lại quy tắc thành `where`.
    const open = await this.prisma.cashDrawerSession.findMany({
      where: { status: CashDrawerStatus.OPEN },
      select: {
        id: true,
        tenantId: true,
        branchId: true,
        businessDate: true,
        status: true,
        branch: BRANCH_NAME_SELECT,
      },
    });
    const overdue = open.filter((session) => isOverdue(session, now));
    if (overdue.length === 0) return 0;

    const recipients = await this.notifications.managersOfLocations(
      overdue.map((s) => ({ tenantId: s.tenantId, locationId: s.branchId })),
    );

    // notify() không bao giờ throw, nên một tenant lỗi không chặn các tenant khác.
    await Promise.all(
      overdue.map((session) =>
        this.notifications.notify({
          tenantId: session.tenantId,
          recipientIds: recipients.get(session.branchId) ?? [],
          referenceId: session.id,
          ...CashDrawerNotificationTemplates.overdue({
            sessionId: session.id,
            branchName: namedBranch(session.branch)?.name ?? 'chi nhánh',
            businessDate: session.businessDate,
          }),
        }),
      ),
    );
    return overdue.length;
  }
}
