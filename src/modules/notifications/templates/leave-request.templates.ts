import type { NotificationContent } from '../notification-content.type';

const link = (leaveRequestId: string) =>
  `/staffs/schedule/leave-requests/${leaveRequestId}`;

/** Notification copy for leave. Four of the five go to the approvers and one to the requester, which is why the requester's name is a parameter on some and absent on others. */
export const LeaveRequestNotificationTemplates = {
  created: (
    requesterName: string,
    leaveRequestId: string,
  ): NotificationContent => ({
    type: 'LEAVE_REQUEST_CREATED',
    title: 'Đơn nghỉ phép mới',
    description: `${requesterName} đã gửi đơn nghỉ phép chờ bạn duyệt.`,
    link: link(leaveRequestId),
  }),

  approved: (leaveRequestId: string): NotificationContent => ({
    type: 'LEAVE_REQUEST_APPROVED',
    title: 'Đơn nghỉ phép được duyệt',
    description: 'Đơn nghỉ phép của bạn đã được duyệt.',
    link: link(leaveRequestId),
  }),

  rejected: (
    leaveRequestId: string,
    reviewNote?: string | null,
  ): NotificationContent => ({
    type: 'LEAVE_REQUEST_REJECTED',
    title: 'Đơn nghỉ phép bị từ chối',
    description: `Đơn nghỉ phép của bạn đã bị từ chối.${
      reviewNote ? ` Lý do: ${reviewNote}` : ''
    }`,
    link: link(leaveRequestId),
  }),

  /** To the approvers - an approved request may have had schedules moved around it. */
  cancelled: (
    requesterName: string,
    leaveRequestId: string,
  ): NotificationContent => ({
    type: 'LEAVE_REQUEST_CANCELLED',
    title: 'Đơn nghỉ phép đã bị hủy',
    description: `${requesterName} đã hủy đơn nghỉ phép.`,
    link: link(leaveRequestId),
  }),

  /** From the nightly sweep: nobody acted before the leave was due to start. */
  expired: (leaveRequestId: string): NotificationContent => ({
    type: 'LEAVE_REQUEST_EXPIRED',
    title: 'Đơn nghỉ phép đã hết hạn',
    description:
      'Đơn nghỉ phép của bạn đã quá ngày bắt đầu mà chưa được duyệt nên đã hết hiệu lực.',
    link: link(leaveRequestId),
  }),
};
