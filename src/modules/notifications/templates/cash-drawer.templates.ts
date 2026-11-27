import type { NotificationContent } from '../notification-content.type';

/** `YYYY-MM-DD` (cột `date`, nửa đêm UTC) -> `10/11/2026`. */
function viDate(businessDate: Date): string {
  const [year, month, day] = businessDate.toISOString().slice(0, 10).split('-');
  return `${day}/${month}/${year}`;
}

export const CashDrawerNotificationTemplates = {
  /** Gửi mỗi sáng cho tới khi két được chốt. Xem `CashDrawerCronService`. */
  overdue: (args: {
    sessionId: string;
    branchName: string;
    businessDate: Date;
  }): NotificationContent => ({
    type: 'CASH_DRAWER_OVERDUE',
    title: 'Két chưa chốt',
    description: `Két ngày ${viDate(args.businessDate)} của ${args.branchName} vẫn chưa chốt. Vui lòng đếm tiền và chốt két trước khi mở két mới.`,
    link: `/cash-drawers/${args.sessionId}`,
  }),
};
