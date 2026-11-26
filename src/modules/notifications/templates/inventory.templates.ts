import type { NotificationContent } from '../notification-content.type';

export const InventoryNotificationTemplates = {
  /** Báo khi dòng vừa xuống dưới ngưỡng. */
  lowStock: (args: {
    label: string;
    stock: number;
    minStock: number;
  }): NotificationContent => ({
    type: 'INVENTORY_LOW_STOCK',
    title: 'Cảnh báo tồn kho thấp',
    description: `${args.label} chỉ còn ${args.stock} (ngưỡng ${args.minStock}). Cân nhắc nhập thêm.`,
    link: '/products',
  }),
};
