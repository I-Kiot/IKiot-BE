import { FulfillmentType } from '../../../common/constants/order-status';
import { ProductItemType } from '../../../common/constants/product-status';
import {
  hasMoreThanTwoDecimals,
  normalizeName,
  numberOf,
  textOf,
} from '../../../common/excel/import-cells';
import type { CellValue, NameIndex } from '../../../common/excel/import-cells';
import { normalizePhone } from '../../../common/utils/phone';
// Chỉ import kiểu: file DTO kéo theo decorator, còn bộ đọc là hàm thuần chạy không cần Nest.
import type {
  CreateOrderDto,
  CreateOrderItemDto,
  DepositType,
} from '../dto/create-order.dto';
import type { OrderItemSpecDto } from '../dto/order-item-customization.dto';
import {
  DEPOSIT_METHOD_LABELS,
  FULFILLMENT_LABELS,
  ORDER_COLUMN_BY_KEY,
  PRIORITY_LABELS,
  SAMPLE_GROUP_PREFIX,
} from './order-import.columns';
import type { OrderImportColumnKey } from './order-import.columns';

// Đọc các dòng file nhập đơn thành CreateOrderDto (đúng body của `POST /orders`), gom mọi lỗi theo dòng. Thuần:
// mọi tra cứu được truyền vào qua `OrderImportLookups`.

export interface OrderImportRow {
  /** Số dòng trong Excel (1-based, tính cả dòng tiêu đề). */
  rowNumber: number;
  cells: Partial<Record<OrderImportColumnKey, CellValue>>;
}

export interface OrderImportError {
  row: number | null;
  column: string | null;
  message: string;
}

export interface OrderImportLookups {
  branches: NameIndex;
  /** Nhân viên: khoá là nhãn trong danh sách ("Tên - SĐT", đã chuẩn hoá) và SĐT chuẩn hoá. */
  staff: Map<string, string[]>;
  /** SKU (nguyên văn) → mặt hàng. */
  items: Map<string, OrderImportItem>;
  /** SĐT chuẩn hoá → khách có sẵn. */
  customersByPhone: Map<string, { id: string; name: string; phone: string }>;
}

/** Mặt hàng mà bộ đọc cần: giá để quy giảm % ra tiền, thuộc tính để đọc thông số làm riêng. */
export interface OrderImportItem {
  id: string;
  sellable: boolean;
  itemType: string;
  retailPrice: number;
  /** Thuộc tính của hàng hoá chứa SKU. */
  attributes: { id: string; name: string; unit: string | null }[];
  /** Giá trị của SKU theo từng thuộc tính (attributeId → giá trị). */
  attributeValues: Map<string, string>;
}

export interface ParsedOrder {
  group: string;
  rows: number[];
  dto: CreateOrderDto;
}

const label = (key: OrderImportColumnKey) =>
  ORDER_COLUMN_BY_KEY.get(key)?.header ?? key;

const byLabel = (labels: Record<string, string>) =>
  new Map(
    Object.entries(labels).flatMap(([value, text]) => [
      [normalizeName(text), value],
      [normalizeName(value), value],
    ]),
  );
const FULFILLMENT_BY_TEXT = byLabel(FULFILLMENT_LABELS);
const PRIORITY_BY_TEXT = byLabel(PRIORITY_LABELS);
const DEPOSIT_METHOD_BY_TEXT = byLabel(DEPOSIT_METHOD_LABELS);

const ORDER_LEVEL_KEYS: readonly OrderImportColumnKey[] = [
  'branch',
  'fulfillmentType',
  'assignee',
  'seller',
  'priority',
  'customerPhone',
  'customerName',
  'recipientName',
  'recipientPhone',
  'deliveryAddress',
  'requestedDeliveryDate',
  'shippingFee',
  'orderDiscount',
  'deposit',
  'depositMethod',
  'note',
];

/** Số điện thoại trong ô: Excel hay cắt số 0 đầu của ô số, nên 9 chữ số không có 0 đầu được thêm lại. */
export function phoneText(value: CellValue): string {
  const text = textOf(value);
  if (typeof value === 'number' && /^\d{9}$/.test(text)) return `0${text}`;
  return text;
}

/** Khoá tra khách theo SĐT: chỉ chữ số, như `CustomerService` lưu `customers.phone`. */
export function customerPhoneKey(phone: string | null | undefined): string {
  return phone?.replace(/\D/g, '') ?? '';
}

/** Khoá tra nhân viên: nhãn "Tên - SĐT" của danh sách, hoặc chỉ SĐT. */
export function staffKeys(name: string, phone: string): string[] {
  const keys = [normalizeName(`${name} - ${phone}`)];
  const normalized = normalizePhone(phone);
  if (normalized) keys.push(normalized);
  return keys;
}

/** Ngày `YYYY-MM-DD` từ ô ngày của Excel, `dd/mm/yyyy` hoặc `yyyy-mm-dd`; null nếu không đọc được. */
export function dateOf(value: CellValue): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? null
      : value.toISOString().slice(0, 10);
  }
  const text = textOf(value);
  let y: number, m: number, d: number;
  let match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
  if (match) {
    [d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else if ((match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text))) {
    [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else {
    return null;
  }
  const date = new Date(Date.UTC(y, m - 1, d));
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== m - 1 ||
    date.getUTCDate() !== d
  ) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

interface Draft {
  group: string;
  rows: number[];
  /** Giá trị cấp đơn và dòng đã đặt nó, để báo "khác với dòng X". */
  fields: Partial<Record<OrderImportColumnKey, { text: string; row: number }>>;
  values: Partial<Record<OrderImportColumnKey, CellValue>>;
  items: CreateOrderItemDto[];
  /** Tiền hàng sau giảm từng dòng, làm tròn như `OrderPricingService.lineTotalOf`; nền của giảm giá đơn theo %. */
  subtotal: number;
}

export function parseOrderImportRows(
  rows: OrderImportRow[],
  lookups: OrderImportLookups,
): { orders: ParsedOrder[]; errors: OrderImportError[] } {
  const errors: OrderImportError[] = [];
  const fail = (
    row: number,
    key: OrderImportColumnKey | null,
    message: string,
  ) => errors.push({ row, column: key ? label(key) : null, message });

  const drafts = new Map<string, Draft>();

  for (const { rowNumber, cells } of rows) {
    const group = textOf(cells.group);
    if (!group) {
      fail(rowNumber, 'group', 'Mã nhóm đơn không được để trống');
      continue;
    }
    if (normalizeName(group).startsWith(normalizeName(SAMPLE_GROUP_PREFIX))) {
      fail(
        rowNumber,
        'group',
        'Đây là dòng mẫu của file - xoá dòng này (hoặc đổi mã nhóm đơn) trước khi nhập',
      );
      continue;
    }
    const groupKey = normalizeName(group);
    let draft = drafts.get(groupKey);
    if (!draft) {
      draft = {
        group,
        rows: [],
        fields: {},
        values: {},
        items: [],
        subtotal: 0,
      };
      drafts.set(groupKey, draft);
    }
    draft.rows.push(rowNumber);

    // Thông tin đơn: dòng đầu đặt, các dòng sau bỏ trống hoặc ghi giống hệt.
    for (const key of ORDER_LEVEL_KEYS) {
      const raw = cells[key];
      const text = normalizeName(textOf(raw));
      if (!text) continue;
      const first = draft.fields[key];
      if (!first) {
        draft.fields[key] = { text, row: rowNumber };
        draft.values[key] = raw;
      } else if (first.text !== text) {
        fail(
          rowNumber,
          key,
          `${label(key)} khác với dòng ${first.row} của cùng đơn "${group}" - để trống hoặc ghi giống dòng đầu`,
        );
      }
    }

    const line = readLine(cells, rowNumber, lookups, fail);
    if (line) {
      draft.items.push(line.item);
      draft.subtotal += line.total;
    }
  }

  const orders: ParsedOrder[] = [];
  for (const draft of drafts.values()) {
    const dto = buildOrder(draft, lookups, fail);
    if (dto) orders.push({ group: draft.group, rows: draft.rows, dto });
  }
  return { orders, errors };
}

type Fail = (
  row: number,
  key: OrderImportColumnKey | null,
  message: string,
) => void;

function readAmount(
  raw: CellValue,
  key: OrderImportColumnKey,
  row: number,
  fail: Fail,
): number | undefined {
  if (!textOf(raw)) return undefined;
  // `numberOf` bỏ dấu %, nên "10%" ở cột chỉ nhận tiền sẽ thành 10 đồng: chặn rõ ràng.
  if (textOf(raw).includes('%')) {
    fail(row, key, `${label(key)} chỉ ghi số tiền, không ghi phần trăm`);
    return undefined;
  }
  const value = numberOf(raw);
  if (value === null) {
    fail(row, key, `${label(key)} phải là số (đang là "${textOf(raw)}")`);
    return undefined;
  }
  if (value < 0) {
    fail(row, key, `${label(key)} không được âm`);
    return undefined;
  }
  if (hasMoreThanTwoDecimals(value)) {
    fail(row, key, `${label(key)} có tối đa 2 chữ số thập phân`);
    return undefined;
  }
  return value;
}

function readLine(
  cells: OrderImportRow['cells'],
  row: number,
  lookups: OrderImportLookups,
  fail: Fail,
): { item: CreateOrderItemDto; total: number } | null {
  let ok = true;
  const sku = textOf(cells.sku);
  let productItemId: string | undefined;
  let found: OrderImportItem | undefined;
  if (!sku) {
    fail(row, 'sku', 'SKU không được để trống');
    ok = false;
  } else {
    const item = lookups.items.get(sku);
    if (!item) {
      fail(row, 'sku', `Không tìm thấy mặt hàng có SKU "${sku}"`);
      ok = false;
    } else if (!item.sellable) {
      fail(row, 'sku', `Mặt hàng "${sku}" đã ngừng kinh doanh`);
      ok = false;
    } else {
      productItemId = item.id;
      found = item;
    }
  }

  const quantityText = textOf(cells.quantity);
  const quantity = numberOf(cells.quantity);
  if (!quantityText) {
    fail(row, 'quantity', 'Số lượng không được để trống');
    ok = false;
  } else if (quantity === null || !Number.isInteger(quantity) || quantity < 1) {
    fail(
      row,
      'quantity',
      `Số lượng phải là số nguyên từ 1 trở lên (đang là "${quantityText}")`,
    );
    ok = false;
  }

  const unitPrice = readAmount(cells.unitPrice, 'unitPrice', row, fail);
  const discountAmount = readAmount(
    cells.lineDiscount,
    'lineDiscount',
    row,
    fail,
  );
  if (textOf(cells.unitPrice) && unitPrice === undefined) ok = false;
  if (textOf(cells.lineDiscount) && discountAmount === undefined) ok = false;

  const customization = found
    ? readCustomization(cells, row, found, fail)
    : undefined;
  if (customization === null) ok = false;

  if (!ok || !productItemId || !found || quantity === null) return null;
  const total = Math.max(
    0,
    Math.round(quantity * (unitPrice ?? found.retailPrice)) -
      (discountAmount ?? 0),
  );
  return {
    item: {
      productItemId,
      quantity,
      ...(unitPrice !== undefined ? { unitPrice } : {}),
      ...(discountAmount ? { discountAmount } : {}),
      ...(customization ? { customization } : {}),
    },
    total,
  };
}

/** Tách "Tên: giá trị; Tên: giá trị" (dấu ; hoặc xuống dòng) thành từng cặp; lỗi viết sẵn cho người sửa file. */
export function splitCustomSpecs(text: string): {
  specs: { name: string; value: string }[];
  errors: string[];
} {
  const specs: { name: string; value: string }[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const piece of text.split(/[;\n]/)) {
    const part = piece.trim();
    if (!part) continue;
    const colon = part.indexOf(':');
    const name = colon > 0 ? part.slice(0, colon).trim() : '';
    const value = colon > 0 ? part.slice(colon + 1).trim() : '';
    if (!name) {
      errors.push(`Thông số "${part}" phải ghi dạng Tên: giá trị`);
    } else if (!value) {
      errors.push(`Thông số "${name}" chưa có giá trị`);
    } else if (seen.has(normalizeName(name))) {
      errors.push(`Thông số "${name}" bị lặp lại trên cùng một dòng`);
    } else {
      seen.add(normalizeName(name));
      specs.push({ name, value });
    }
  }
  return { specs, errors };
}

/**
 * Thông số làm riêng của một dòng, đúng khối `customization` mà hộp thoại "Thông số làm riêng" của form gửi: tên trùng
 * thuộc tính của hàng hoá là đổi thuộc tính đó (bỏ qua nếu giống giá trị gốc của SKU), tên khác là thông số thêm.
 * `undefined` = dòng thường, `null` = có lỗi (đã ghi).
 */
function readCustomization(
  cells: OrderImportRow['cells'],
  row: number,
  item: OrderImportItem,
  fail: Fail,
): CreateOrderItemDto['customization'] | null | undefined {
  const specText = textOf(cells.customSpecs);
  const note = textOf(cells.customNote);
  if (!specText && !note) return undefined;

  // Như `OrderCustomizationService.assertCustomizable`: dòng combo chỉ là giá, dịch vụ không có hàng để làm.
  if (item.itemType !== ProductItemType.PRODUCT) {
    fail(
      row,
      specText ? 'customSpecs' : 'customNote',
      item.itemType === ProductItemType.COMBO
        ? 'Dòng combo không làm riêng được từ file - nhập combo rồi làm riêng từng món trên màn hình đơn'
        : 'Dịch vụ không làm riêng được',
    );
    return null;
  }

  const { specs: pairs, errors } = splitCustomSpecs(specText);
  for (const message of errors) fail(row, 'customSpecs', message);
  if (errors.length > 0) return null;

  const specs: OrderItemSpecDto[] = [];
  for (const pair of pairs) {
    const attribute = item.attributes.find(
      (a) => normalizeName(a.name) === normalizeName(pair.name),
    );
    if (!attribute) {
      specs.push(pair);
      continue;
    }
    // "200 cm" với thuộc tính đơn vị cm: đơn vị thuộc về thuộc tính, giá trị chỉ là "200".
    let value = pair.value;
    const unit = attribute.unit?.trim();
    if (unit && normalizeName(value).endsWith(` ${normalizeName(unit)}`)) {
      value = value.slice(0, value.length - unit.length).trim();
    }
    const base = item.attributeValues.get(attribute.id);
    if (base !== undefined && normalizeName(base) === normalizeName(value)) {
      continue;
    }
    specs.push({
      attributeId: attribute.id,
      name: attribute.name,
      value,
      ...(unit ? { unit } : {}),
    });
  }

  if (specs.length === 0 && !note) {
    fail(
      row,
      'customSpecs',
      'Thông số làm riêng giống hệt mặt hàng gốc - để trống nếu dòng này không làm riêng',
    );
    return null;
  }
  return { ...(specs.length > 0 ? { specs } : {}), ...(note ? { note } : {}) };
}

/** "Giảm giá đơn": số tiền, hoặc phần trăm quy ra tiền trên tiền hàng sau giảm dòng; không vượt tiền hàng. */
function readOrderDiscount(
  raw: CellValue,
  row: number,
  subtotal: number,
  fail: Fail,
): number | undefined {
  const text = textOf(raw);
  if (!text) return undefined;
  if (!text.includes('%')) {
    const amount = readAmount(raw, 'orderDiscount', row, fail);
    if (amount !== undefined && amount > subtotal) {
      fail(
        row,
        'orderDiscount',
        `Giảm giá đơn (${amount.toLocaleString('vi-VN')}) lớn hơn tiền hàng sau giảm dòng (${subtotal.toLocaleString('vi-VN')})`,
      );
      return undefined;
    }
    return amount;
  }
  const percent = numberOf(text);
  if (percent === null || percent <= 0 || percent > 100) {
    fail(
      row,
      'orderDiscount',
      `Giảm giá đơn theo phần trăm phải lớn hơn 0% và không quá 100% (đang là "${text}")`,
    );
    return undefined;
  }
  if (hasMoreThanTwoDecimals(percent)) {
    fail(row, 'orderDiscount', 'Phần trăm giảm có tối đa 2 chữ số thập phân');
    return undefined;
  }
  return Math.round((subtotal * percent) / 100);
}

function buildOrder(
  draft: Draft,
  lookups: OrderImportLookups,
  fail: Fail,
): CreateOrderDto | null {
  const first = draft.rows[0];
  const rowOf = (key: OrderImportColumnKey) => draft.fields[key]?.row ?? first;
  const raw = (key: OrderImportColumnKey) => draft.values[key];
  const text = (key: OrderImportColumnKey) => textOf(raw(key));
  const errorsBefore = { count: 0 };
  const failOrder: Fail = (row, key, message) => {
    errorsBefore.count++;
    fail(row, key, message);
  };

  // Chi nhánh.
  let branchId: string | undefined;
  const branchName = text('branch');
  if (!branchName) {
    failOrder(first, 'branch', `Đơn "${draft.group}": chưa chọn chi nhánh`);
  } else {
    const ids = lookups.branches.get(normalizeName(branchName)) ?? [];
    if (ids.length === 0) {
      failOrder(
        rowOf('branch'),
        'branch',
        `Không có chi nhánh "${branchName}" - chọn trong danh sách`,
      );
    } else if (ids.length > 1) {
      failOrder(
        rowOf('branch'),
        'branch',
        `Có nhiều chi nhánh tên "${branchName}" - đổi tên cho khác nhau trên hệ thống`,
      );
    } else {
      branchId = ids[0];
    }
  }

  // Hình thức nhận hàng.
  const fulfillmentText = text('fulfillmentType');
  const fulfillmentType = FULFILLMENT_BY_TEXT.get(
    normalizeName(fulfillmentText),
  );
  if (!fulfillmentText) {
    failOrder(
      first,
      'fulfillmentType',
      `Đơn "${draft.group}": chưa chọn hình thức nhận hàng`,
    );
  } else if (!fulfillmentType) {
    failOrder(
      rowOf('fulfillmentType'),
      'fulfillmentType',
      `Hình thức nhận hàng "${fulfillmentText}" không hợp lệ - chọn ${Object.values(FULFILLMENT_LABELS).join(' hoặc ')}`,
    );
  }

  // Nhân viên.
  const person = (
    key: 'assignee' | 'seller',
    required: boolean,
  ): string | undefined => {
    const value = text(key);
    if (!value) {
      if (required) {
        failOrder(
          first,
          key,
          `Đơn "${draft.group}": chưa chọn ${label(key).toLowerCase()}`,
        );
      }
      return undefined;
    }
    const ids =
      lookups.staff.get(normalizeName(value)) ??
      lookups.staff.get(normalizePhone(phoneText(raw(key)))) ??
      [];
    if (ids.length === 1) return ids[0];
    failOrder(
      rowOf(key),
      key,
      ids.length === 0
        ? `Không tìm thấy nhân viên "${value}" - chọn trong danh sách hoặc ghi số điện thoại`
        : `"${value}" khớp nhiều nhân viên - ghi số điện thoại`,
    );
    return undefined;
  };
  const assigneeId = person('assignee', true);
  const sellerId = person('seller', false);

  // Mức ưu tiên.
  const priorityText = text('priority');
  const priority = priorityText
    ? PRIORITY_BY_TEXT.get(normalizeName(priorityText))
    : undefined;
  if (priorityText && !priority) {
    failOrder(
      rowOf('priority'),
      'priority',
      `Mức ưu tiên "${priorityText}" không hợp lệ - chọn ${Object.values(PRIORITY_LABELS).join(', ')}`,
    );
  }

  // Khách hàng.
  const customerPhone = phoneText(raw('customerPhone'));
  const customerName = text('customerName');
  const existing = customerPhone
    ? lookups.customersByPhone.get(customerPhoneKey(customerPhone))
    : undefined;
  let customer: Pick<CreateOrderDto, 'customerId' | 'customer'> = {};
  if (existing) {
    customer = { customerId: existing.id };
  } else if (customerName) {
    customer = {
      customer: {
        name: customerName,
        ...(customerPhone ? { phone: customerPhone } : {}),
      },
    };
  } else if (customerPhone) {
    failOrder(
      rowOf('customerPhone'),
      'customerName',
      `Chưa có khách hàng SĐT ${customerPhone} - ghi Tên khách hàng để tạo khách mới`,
    );
  }

  // Giao hàng: bỏ trống người nhận / SĐT thì lấy theo khách, như form tạo đơn.
  const isDelivery = fulfillmentType === FulfillmentType.HOME_DELIVERY;
  const recipientName =
    text('recipientName') ||
    (isDelivery ? existing?.name || customerName : '') ||
    undefined;
  const recipientPhone =
    phoneText(raw('recipientPhone')) ||
    (isDelivery ? customerPhone : '') ||
    undefined;
  const deliveryAddress = text('deliveryAddress') || undefined;
  if (isDelivery) {
    const missing = [
      !recipientName && 'người nhận',
      !recipientPhone && 'SĐT người nhận',
      !deliveryAddress && 'địa chỉ giao',
    ].filter(Boolean);
    if (missing.length > 0) {
      failOrder(
        first,
        !deliveryAddress ? 'deliveryAddress' : 'recipientName',
        `Đơn "${draft.group}" giao tận nơi còn thiếu ${missing.join(', ')}`,
      );
    }
  }

  let requestedDeliveryDate: string | undefined;
  if (text('requestedDeliveryDate')) {
    const date = dateOf(raw('requestedDeliveryDate'));
    if (!date) {
      failOrder(
        rowOf('requestedDeliveryDate'),
        'requestedDeliveryDate',
        `Ngày giao "${text('requestedDeliveryDate')}" không hợp lệ - ghi dd/mm/yyyy`,
      );
    } else {
      requestedDeliveryDate = date;
    }
  }

  const shippingFee = readAmount(
    raw('shippingFee'),
    'shippingFee',
    rowOf('shippingFee'),
    failOrder,
  );
  if (shippingFee && fulfillmentType === FulfillmentType.STORE_PICKUP) {
    failOrder(
      rowOf('shippingFee'),
      'shippingFee',
      'Khách đến lấy không có phí giao hàng - để trống ô này',
    );
  }
  // Tiền hàng chỉ đủ khi mọi dòng đọc được; dòng hỏng đã có lỗi riêng nên khỏi so giảm giá đơn với một tổng thiếu.
  const orderDiscount =
    draft.items.length === draft.rows.length
      ? readOrderDiscount(
          raw('orderDiscount'),
          rowOf('orderDiscount'),
          draft.subtotal,
          failOrder,
        )
      : undefined;
  const deposit = readAmount(
    raw('deposit'),
    'deposit',
    rowOf('deposit'),
    failOrder,
  );
  const depositMethodText = text('depositMethod');
  const depositMethod = depositMethodText
    ? DEPOSIT_METHOD_BY_TEXT.get(normalizeName(depositMethodText))
    : undefined;
  if (depositMethodText && !depositMethod) {
    failOrder(
      rowOf('depositMethod'),
      'depositMethod',
      `Hình thức cọc "${depositMethodText}" không hợp lệ - chọn ${Object.values(DEPOSIT_METHOD_LABELS).join(' hoặc ')}`,
    );
  }
  if (deposit && !depositMethodText) {
    failOrder(
      rowOf('deposit'),
      'depositMethod',
      'Có tiền cọc thì phải chọn hình thức cọc',
    );
  }

  if (draft.items.length !== draft.rows.length || errorsBefore.count > 0) {
    // Đơn có dòng hỏng hoặc thông tin đơn sai: lỗi đã được ghi, không dựng đơn.
    return null;
  }
  if (!branchId || !fulfillmentType || !assigneeId) return null;

  return {
    branchId,
    fulfillmentType,
    assigneeId,
    ...(sellerId ? { sellerId } : {}),
    ...(priority ? { priority } : {}),
    ...customer,
    ...(recipientName ? { recipientName } : {}),
    ...(recipientPhone ? { recipientPhone } : {}),
    ...(isDelivery && deliveryAddress ? { deliveryAddress } : {}),
    ...(requestedDeliveryDate ? { requestedDeliveryDate } : {}),
    ...(shippingFee ? { shippingFee } : {}),
    ...(orderDiscount
      ? { discountType: 'ORDER', discountValue: orderDiscount }
      : {}),
    ...(deposit && depositMethod
      ? {
          deposit: {
            type: 'AMOUNT' satisfies DepositType,
            value: deposit,
            method: depositMethod,
          },
        }
      : {}),
    ...(text('note') ? { note: text('note') } : {}),
    items: draft.items,
  };
}
