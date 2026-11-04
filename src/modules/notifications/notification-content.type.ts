/** Nội dung thông báo (title, description, link), do template theo domain tạo, không viết inline trong service nghiệp vụ. */
export interface NotificationContent {
  type: string;
  title: string;
  description: string;
  link?: string;
}
