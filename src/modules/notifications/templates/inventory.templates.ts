import type { NotificationContent } from '../notification-content.type';

/** Notification copy for the inventory domain; InventoryService calls these instead of writing title/description inline. */
export const InventoryNotificationTemplates = {
  /** Sent the moment a line crosses its low-stock threshold, not every time it sits below it - see `InventoryService.lowStockCrossing`. */
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
