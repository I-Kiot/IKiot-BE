import {
  FulfillmentType,
  OrderPriority,
} from '../../../common/constants/order-status';
import { PaymentMethod } from '../../../common/constants/payment-method';
import { headerKey } from '../../../common/excel/import-cells';

// Bảng cột của file nhập đơn hàng, dùng chung cho file mẫu và bộ đọc. Mỗi dòng là một dòng hàng; các dòng cùng
// "Mã nhóm đơn" là một đơn, thông tin đơn chỉ cần điền ở dòng đầu (như "Tên hàng hóa" của file nhập hàng hoá).

/** Giới hạn dòng một lần nhập; cả file ghi trong một transaction. */
export const MAX_ORDER_IMPORT_ROWS = 1000;
/** Giới hạn số đơn một lần nhập. */
export const MAX_ORDER_IMPORT_ORDERS = 200;
export const MAX_ORDER_IMPORT_BYTES = 5 * 1024 * 1024;

export const ORDER_IMPORT_SHEET = 'Đơn hàng';
/** Mã nhóm của các đơn mẫu có sẵn trong file mẫu; bộ đọc từ chối chúng để không ai lỡ nhập đơn mẫu. */
export const SAMPLE_GROUP_PREFIX = 'MẪU-';
export const ORDER_GUIDE_SHEET = 'Hướng dẫn';
export const ORDER_LISTS_SHEET = 'Danh sách';

export type OrderImportList =
  'branches' | 'staff' | 'fulfillmentTypes' | 'priorities' | 'depositMethods';

export type OrderImportColumnKey =
  | 'group'
  | 'branch'
  | 'fulfillmentType'
  | 'assignee'
  | 'seller'
  | 'priority'
  | 'customerPhone'
  | 'customerName'
  | 'recipientName'
  | 'recipientPhone'
  | 'deliveryAddress'
  | 'requestedDeliveryDate'
  | 'shippingFee'
  | 'orderDiscount'
  | 'deposit'
  | 'depositMethod'
  | 'note'
  | 'sku'
  | 'quantity'
  | 'unitPrice'
  | 'lineDiscount';

export interface OrderImportColumn {
  key: OrderImportColumnKey;
  header: string;
  required: boolean;
  /** `order`: chỉ cần điền ở dòng đầu của đơn; `line`: mỗi dòng (mỗi mặt hàng) một giá trị. */
  level: 'order' | 'line';
  width: number;
  format: string;
  example: string;
  note: string;
  list?: OrderImportList;
  /** Ô dạng chữ (`@`): giữ số 0 ở đầu số điện thoại, SKU. */
  text?: boolean;
  money?: boolean;
}

export const FULFILLMENT_LABELS: Record<string, string> = {
  [FulfillmentType.HOME_DELIVERY]: 'Giao tận nơi',
  [FulfillmentType.STORE_PICKUP]: 'Khách đến lấy',
};

export const PRIORITY_LABELS: Record<string, string> = {
  [OrderPriority.NORMAL]: 'Bình thường',
  [OrderPriority.HIGH]: 'Cao',
  [OrderPriority.URGENT]: 'Gấp',
};

/** Cọc lúc tạo đơn chỉ nhận tiền mặt hoặc chuyển khoản, như form tạo đơn (`DEPOSIT_METHODS`). */
export const DEPOSIT_METHOD_LABELS: Record<string, string> = {
  [PaymentMethod.CASH]: 'Tiền mặt',
  [PaymentMethod.BANK_TRANSFER]: 'Chuyển khoản',
};

export const ORDER_IMPORT_COLUMNS: readonly OrderImportColumn[] = [
  {
    key: 'group',
    header: 'Mã nhóm đơn',
    required: true,
    level: 'order',
    width: 14,
    format: 'Chữ / số tự đặt',
    example: 'DH1',
    note: 'Các dòng cùng mã nhóm là một đơn (mỗi dòng một mặt hàng). Chỉ dùng để gom dòng trong file; mã đơn do hệ thống sinh.',
    text: true,
  },
  {
    key: 'branch',
    header: 'Chi nhánh',
    required: true,
    level: 'order',
    width: 22,
    format: 'Chọn trong danh sách',
    example: 'CN Hà Nội',
    note: 'Chi nhánh nhận đơn. Nhân viên chỉ nhập được đơn của chi nhánh mình.',
    list: 'branches',
  },
  {
    key: 'fulfillmentType',
    header: 'Hình thức nhận hàng',
    required: true,
    level: 'order',
    width: 18,
    format: 'Chọn trong danh sách',
    example: FULFILLMENT_LABELS.HOME_DELIVERY,
    note: 'Giao tận nơi cần người nhận, SĐT và địa chỉ (bỏ trống người nhận / SĐT thì lấy theo khách). Khách đến lấy không có phí giao hàng.',
    list: 'fulfillmentTypes',
  },
  {
    key: 'assignee',
    header: 'Người phụ trách',
    required: true,
    level: 'order',
    width: 30,
    format: 'Chọn trong danh sách, hoặc số điện thoại',
    example: 'Nguyễn Văn A - 0901234567',
    note: 'Phải làm việc tại chi nhánh của đơn (chủ cửa hàng phụ trách được mọi nơi).',
    list: 'staff',
  },
  {
    key: 'seller',
    header: 'Nhân viên bán hàng',
    required: false,
    level: 'order',
    width: 30,
    format: 'Chọn trong danh sách, hoặc số điện thoại',
    example: '',
    note: 'Bỏ trống là người nhập file.',
    list: 'staff',
  },
  {
    key: 'priority',
    header: 'Mức ưu tiên',
    required: false,
    level: 'order',
    width: 14,
    format: 'Chọn trong danh sách',
    example: PRIORITY_LABELS.NORMAL,
    note: 'Bỏ trống là Bình thường.',
    list: 'priorities',
  },
  {
    key: 'customerPhone',
    header: 'SĐT khách hàng',
    required: false,
    level: 'order',
    width: 16,
    format: 'Số điện thoại',
    example: '0912345678',
    note: 'Khớp khách đã có theo số điện thoại; chưa có thì tạo khách mới (cần Tên khách hàng). Bỏ trống cả SĐT lẫn tên là khách vãng lai.',
    text: true,
  },
  {
    key: 'customerName',
    header: 'Tên khách hàng',
    required: false,
    level: 'order',
    width: 22,
    format: 'Chữ',
    example: 'Trần Thị B',
    note: 'Bắt buộc khi là khách mới.',
  },
  {
    key: 'recipientName',
    header: 'Người nhận',
    required: false,
    level: 'order',
    width: 20,
    format: 'Chữ',
    example: '',
    note: 'Giao tận nơi: bỏ trống thì lấy tên khách.',
  },
  {
    key: 'recipientPhone',
    header: 'SĐT người nhận',
    required: false,
    level: 'order',
    width: 16,
    format: 'Số điện thoại',
    example: '',
    note: 'Giao tận nơi: bỏ trống thì lấy SĐT khách.',
    text: true,
  },
  {
    key: 'deliveryAddress',
    header: 'Địa chỉ giao',
    required: false,
    level: 'order',
    width: 36,
    format: 'Chữ',
    example: '12 Láng Hạ, Đống Đa, Hà Nội',
    note: 'Bắt buộc khi giao tận nơi.',
  },
  {
    key: 'requestedDeliveryDate',
    header: 'Ngày giao mong muốn',
    required: false,
    level: 'order',
    width: 16,
    format: 'Ngày (dd/mm/yyyy)',
    example: '30/11/2026',
    note: '',
  },
  {
    key: 'shippingFee',
    header: 'Phí giao hàng',
    required: false,
    level: 'order',
    width: 14,
    format: 'Số tiền (đồng)',
    example: '50000',
    note: 'Khách đến lấy thì để trống.',
    money: true,
  },
  {
    key: 'orderDiscount',
    header: 'Giảm giá đơn',
    required: false,
    level: 'order',
    width: 14,
    format: 'Số tiền (đồng)',
    example: '',
    note: 'Giảm trên cả đơn (ngoài giảm giá từng dòng).',
    money: true,
  },
  {
    key: 'deposit',
    header: 'Tiền cọc',
    required: false,
    level: 'order',
    width: 14,
    format: 'Số tiền (đồng)',
    example: '1000000',
    note: 'Tiền đã thu lúc tạo đơn, vào sổ thu chi ngay. Không vượt tổng đơn.',
    money: true,
  },
  {
    key: 'depositMethod',
    header: 'Hình thức cọc',
    required: false,
    level: 'order',
    width: 14,
    format: 'Chọn trong danh sách',
    example: DEPOSIT_METHOD_LABELS.CASH,
    note: 'Bắt buộc khi có tiền cọc.',
    list: 'depositMethods',
  },
  {
    key: 'note',
    header: 'Ghi chú đơn',
    required: false,
    level: 'order',
    width: 30,
    format: 'Chữ',
    example: '',
    note: '',
  },
  {
    key: 'sku',
    header: 'SKU',
    required: true,
    level: 'line',
    width: 18,
    format: 'SKU mặt hàng có sẵn',
    example: 'BAN-SOI-NAU',
    note: 'SKU của mặt hàng đang kinh doanh (xem trên màn hàng hóa). Combo nhập bằng SKU của combo.',
    text: true,
  },
  {
    key: 'quantity',
    header: 'Số lượng',
    required: true,
    level: 'line',
    width: 10,
    format: 'Số nguyên ≥ 1',
    example: '1',
    note: '',
  },
  {
    key: 'unitPrice',
    header: 'Đơn giá',
    required: false,
    level: 'line',
    width: 14,
    format: 'Số tiền (đồng)',
    example: '',
    note: 'Bỏ trống thì lấy giá bán lẻ hiện tại.',
    money: true,
  },
  {
    key: 'lineDiscount',
    header: 'Giảm giá dòng',
    required: false,
    level: 'line',
    width: 14,
    format: 'Số tiền (đồng)',
    example: '',
    note: 'Giảm trên dòng này (tổng, không phải mỗi chiếc).',
    money: true,
  },
];

export function orderHeaderLabel(column: OrderImportColumn): string {
  return column.required ? `${column.header} (*)` : column.header;
}

/** Tiêu đề (đã chuẩn hoá) → cột, để đọc file theo tiêu đề chứ không theo vị trí. */
export const ORDER_COLUMN_BY_HEADER = new Map(
  ORDER_IMPORT_COLUMNS.map((column) => [headerKey(column.header), column]),
);

export const ORDER_COLUMN_BY_KEY = new Map(
  ORDER_IMPORT_COLUMNS.map((column) => [column.key, column]),
);
