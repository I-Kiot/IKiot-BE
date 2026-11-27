/** Nội dung thông báo: tiêu đề, mô tả, link. */
export interface NotificationContent {
  type: string;
  title: string;
  description: string;
  link?: string;
}
