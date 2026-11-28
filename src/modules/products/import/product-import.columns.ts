import {
  ProductStatus,
  ProductType,
} from '../../../common/constants/product-status';

import { NO, YES, headerKey } from '../../../common/excel/import-cells';

// Bảng cột của file nhập hàng hoá, dùng chung cho file mẫu và bộ đọc.

export { NO, YES, headerKey };

/** Số cặp thuộc tính (tên / đơn vị / giá trị) có trong template. */
export const IMPORT_ATTRIBUTE_SLOTS = 3;

/** Giới hạn số dòng dữ liệu một lần import - cả file chạy trong một transaction. */
export const MAX_IMPORT_ROWS = 1000;

/** File lớn hơn thế này gần như chắc chắn không phải template (1000 dòng chỉ cỡ vài trăm KB). */
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

export const IMPORT_SHEET = 'Hàng hóa';
export const GUIDE_SHEET = 'Hướng dẫn';
export const LISTS_SHEET = 'Danh sách';

/** Danh sách giá trị mà một cột lấy từ trang "Danh sách" (dropdown trong Excel). */
export type ImportList =
  'categories' | 'brands' | 'suppliers' | 'statuses' | 'productTypes' | 'yesNo';

export type ImportColumnKey =
  | 'name'
  | 'productType'
  | 'category'
  | 'brand'
  | 'status'
  | 'isManufacturable'
  | 'itemName'
  | 'productCode'
  | 'sku'
  | 'barcode'
  | 'retailPrice'
  | 'costPrice'
  | 'vat'
  | 'warrantyPeriod'
  | 'suppliers'
  | `attrName${number}`
  | `attrUnit${number}`
  | `attrValue${number}`
  | 'description';

export interface ImportColumn {
  key: ImportColumnKey;
  header: string;
  /** Tiêu đề cũ vẫn được nhận khi đọc file, để template tải về trước khi đổi tên cột không thành vô dụng. */
  aliases?: string[];
  required: boolean;
  /** `product`: chỉ cần điền ở dòng đầu tiên của hàng hoá; `item`: mỗi dòng (mỗi SKU) một giá trị. */
  level: 'product' | 'item';
  width: number;
  format: string;
  example: string;
  note: string;
  list?: ImportList;
  /** Dropdown chỉ gợi ý, vẫn cho gõ tự do - cột nhiều giá trị cách nhau bởi dấu `;`. */
  freeText?: boolean;
  /** Ô dạng chữ (`@`): giữ số 0 ở đầu mã vạch, mã hàng. */
  text?: boolean;
  money?: boolean;
}

export const STATUS_LABELS: Record<string, string> = {
  [ProductStatus.ACTIVE]: 'Đang kinh doanh',
  [ProductStatus.INACTIVE]: 'Ngừng kinh doanh',
};

/** COMBO không có ở đây: một combo cần danh sách thành phần, thứ một dòng Excel không diễn đạt được. */
export const PRODUCT_TYPE_LABELS: Record<string, string> = {
  [ProductType.PRODUCT]: 'Hàng hóa',
  [ProductType.SERVICE]: 'Dịch vụ',
};

function attributeColumns(): ImportColumn[] {
  const columns: ImportColumn[] = [];
  for (let n = 1; n <= IMPORT_ATTRIBUTE_SLOTS; n++) {
    columns.push(
      {
        key: `attrName${n}`,
        header: `Thuộc tính ${n}`,
        required: false,
        level: 'item',
        width: 16,
        format: 'Chữ',
        example: n === 1 ? 'Màu' : n === 2 ? 'Chiều dài' : '',
        note: 'Tên thuộc tính phân biệt các phiên bản (Màu, Kích thước...). Các dòng của cùng hàng hóa nên dùng cùng tên thuộc tính.',
      },
      {
        key: `attrUnit${n}`,
        header: `Đơn vị ${n}`,
        required: false,
        level: 'item',
        width: 10,
        format: 'Chữ',
        example: n === 2 ? 'cm' : '',
        note: 'Đơn vị của thuộc tính (cm, kg...). Bỏ trống nếu không có. Cùng một thuộc tính phải cùng đơn vị trên mọi dòng của hàng hóa.',
      },
      {
        key: `attrValue${n}`,
        header: `Giá trị ${n}`,
        required: false,
        level: 'item',
        width: 14,
        format: 'Chữ hoặc số',
        example: n === 1 ? 'Nâu' : n === 2 ? '120' : '',
        note: `Bắt buộc khi đã điền "Thuộc tính ${n}".`,
      },
    );
  }
  return columns;
}

export const IMPORT_COLUMNS: ImportColumn[] = [
  {
    key: 'name',
    header: 'Tên hàng hóa',
    required: true,
    level: 'product',
    width: 30,
    format: 'Chữ',
    example: 'Bàn làm việc gỗ sồi',
    note: 'Các dòng có cùng tên hàng hóa là các phiên bản (SKU) của một hàng hóa. Không được trùng tên hàng hóa đã có trong cửa hàng.',
  },
  {
    key: 'productType',
    header: 'Loại hàng hóa',
    // Loại hàng hoá, áp cho mọi SKU của hàng hoá.
    aliases: ['Loại mặt hàng'],
    required: false,
    level: 'product',
    width: 14,
    format: `${PRODUCT_TYPE_LABELS.PRODUCT} / ${PRODUCT_TYPE_LABELS.SERVICE}`,
    example: PRODUCT_TYPE_LABELS.PRODUCT,
    note: `Bỏ trống = ${PRODUCT_TYPE_LABELS.PRODUCT}. Mọi mặt hàng của một hàng hóa cùng loại. Dịch vụ không có tồn kho. Combo không nhập được bằng file - tạo ở màn hình Combo.`,
    list: 'productTypes',
  },
  {
    key: 'category',
    header: 'Danh mục',
    required: false,
    level: 'product',
    width: 24,
    format: 'Chọn từ danh sách',
    example: 'Bàn',
    note: 'Phải là danh mục đã có trong cửa hàng. Danh mục con viết dạng "Cha > Con".',
    list: 'categories',
  },
  {
    key: 'brand',
    header: 'Thương hiệu',
    required: false,
    level: 'product',
    width: 18,
    format: 'Chọn từ danh sách',
    example: '',
    note: 'Phải là thương hiệu đã có trong cửa hàng.',
    list: 'brands',
  },
  {
    key: 'status',
    header: 'Trạng thái',
    required: false,
    level: 'product',
    width: 18,
    format: `${STATUS_LABELS.ACTIVE} / ${STATUS_LABELS.INACTIVE}`,
    example: STATUS_LABELS.ACTIVE,
    note: `Bỏ trống = ${STATUS_LABELS.ACTIVE}.`,
    list: 'statuses',
  },
  {
    key: 'isManufacturable',
    header: 'Đặt xưởng sản xuất',
    required: false,
    level: 'product',
    width: 12,
    format: `${YES} / ${NO}`,
    example: YES,
    note: `"${YES}" nếu hàng có thể đặt xưởng sản xuất (YCSX). Bỏ trống = ${NO}: chỉ nhập từ nhà cung cấp.`,
    list: 'yesNo',
  },
  {
    key: 'itemName',
    header: 'Tên mặt hàng',
    required: false,
    level: 'item',
    width: 30,
    format: 'Chữ',
    example: 'Bàn làm việc gỗ sồi - Nâu - 120',
    note: 'Tên của phiên bản. Bỏ trống = tên hàng hóa kèm các giá trị thuộc tính.',
  },
  {
    key: 'productCode',
    header: 'Mã hàng',
    required: false,
    level: 'item',
    width: 14,
    format: 'Chữ, không trùng',
    example: '',
    note: 'Không được trùng trong file và với mã hàng đã có. Bỏ trống để hệ thống tự sinh (SP000001...).',
    text: true,
  },
  {
    key: 'sku',
    header: 'SKU',
    required: false,
    level: 'item',
    width: 16,
    format: 'Chữ, không trùng',
    example: 'BAN-SOI-120',
    note: 'Không được trùng trong file và với SKU đã có. Bỏ trống = theo mã hàng.',
    text: true,
  },
  {
    key: 'barcode',
    header: 'Mã vạch',
    required: false,
    level: 'item',
    width: 16,
    format: 'Chữ, không trùng',
    example: '8936012345678',
    note: 'Không được trùng trong file và với mã vạch đã có. Bỏ trống nếu hàng không có mã vạch.',
    text: true,
  },
  {
    key: 'retailPrice',
    header: 'Giá bán',
    required: true,
    level: 'item',
    width: 14,
    format: 'Số ≥ 0 (VNĐ)',
    example: '3500000',
    note: 'Ghi số, không ghi chữ "đ".',
    money: true,
  },
  {
    key: 'costPrice',
    header: 'Giá vốn',
    required: true,
    level: 'item',
    width: 14,
    format: 'Số ≥ 0 (VNĐ)',
    example: '2400000',
    note: 'Ghi số, không ghi chữ "đ". Hàng chưa rõ giá vốn ghi 0.',
    money: true,
  },
  {
    key: 'vat',
    header: 'VAT (%)',
    required: false,
    level: 'item',
    width: 9,
    format: 'Số từ 0 đến 100',
    example: '10',
    note: 'Ghi 10 cho 10%.',
  },
  {
    key: 'warrantyPeriod',
    header: 'Bảo hành',
    required: false,
    level: 'item',
    width: 12,
    format: 'Chữ',
    example: '24 tháng',
    note: '',
  },
  {
    key: 'suppliers',
    header: 'Nhà cung cấp',
    required: false,
    level: 'item',
    width: 24,
    format: 'Chọn từ danh sách, nhiều nhà cung cấp cách nhau bởi dấu ;',
    example: '',
    note: 'Phải là nhà cung cấp đã có trong cửa hàng.',
    list: 'suppliers',
    freeText: true,
  },
  ...attributeColumns(),
  {
    key: 'description',
    header: 'Mô tả',
    required: false,
    level: 'item',
    width: 30,
    format: 'Chữ',
    example: '',
    note: '',
  },
];

/** Tiêu đề hiển thị trên template: cột bắt buộc có thêm `(*)`. */
export function headerLabel(column: ImportColumn): string {
  return column.required ? `${column.header} (*)` : column.header;
}

// ─── Tồn kho đầu kỳ ───
// Không nằm trong IMPORT_COLUMNS vì số cột phụ thuộc cửa hàng: mỗi kho/chi nhánh một cột,
// tiêu đề "Tồn kho - <tên địa điểm>". Bộ đọc nhận cột theo tên địa điểm, không theo vị trí.

export const STOCK_HEADER_PREFIX = 'Tồn kho - ';

export const STOCK_COLUMN_WIDTH = 14;

export const STOCK_COLUMN_FORMAT = 'Số nguyên ≥ 0';

export const STOCK_COLUMN_NOTE =
  'Số lượng đang có tại địa điểm này lúc nhập file. Bỏ trống hoặc 0 = không có hàng ở đây. Hệ thống tạo một phiếu điều chỉnh tồn kho đã hoàn tất cho mỗi địa điểm có số lượng. Dịch vụ không có tồn kho.';

export function stockHeader(locationName: string): string {
  return `${STOCK_HEADER_PREFIX}${locationName}`;
}

/** Tên địa điểm trong tiêu đề cột tồn kho, `null` nếu không phải cột tồn kho. Nhận cả "-", "–" và ":". */
export function stockLocationOf(header: string): string | null {
  const match = /^tồn kho\s*[-–:]\s*(.+)$/u.exec(headerKey(header));
  return match ? match[1].trim() : null;
}
