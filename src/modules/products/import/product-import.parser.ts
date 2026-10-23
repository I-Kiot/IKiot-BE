import { ProductItemType } from '../../../common/constants/product-status';
import type { CreateProductDto } from '../dto/create-product.dto';
import type { CreateProductItemDto } from '../dto/product-item.dto';
import {
  IMPORT_ATTRIBUTE_SLOTS,
  IMPORT_COLUMNS,
  ITEM_TYPE_LABELS,
  NO,
  STATUS_LABELS,
  YES,
} from './product-import.columns';
import type { ImportColumn, ImportColumnKey } from './product-import.columns';

// Đọc các dòng của file import thành CreateProductDto. Thuần tuý - không đụng database: mọi thứ cần
// tra (danh mục, thương hiệu, NCC, SKU và tên đã có) được service nạp sẵn và đưa vào qua `lookups`.
// Mọi lỗi được gom lại theo dòng thay vì dừng ở lỗi đầu tiên: người dùng sửa cả file một lần.

export type CellValue = string | number | boolean | Date | null | undefined;

export interface ImportRow {
  /** Số dòng trong Excel (1-based, tính cả dòng tiêu đề) - con số người dùng nhìn thấy. */
  rowNumber: number;
  cells: Partial<Record<ImportColumnKey, CellValue>>;
}

export interface ImportError {
  /** `null` cho lỗi của cả file (thiếu cột, quá nhiều dòng...). */
  row: number | null;
  /** Tiêu đề cột như trên template, `null` khi lỗi không thuộc một cột. */
  column: string | null;
  message: string;
}

/** Tên → id, đã chuẩn hoá. Một tên trỏ về nhiều id là tên trùng: không chọn bừa. */
export type NameIndex = Map<string, string[]>;

export interface ImportLookups {
  categories: NameIndex;
  brands: NameIndex;
  suppliers: NameIndex;
  /** Tên hàng hoá (chuẩn hoá) đã có trong cửa hàng, trừ hàng đã ngừng sản xuất. */
  takenProductNames: ReadonlySet<string>;
  /** SKU đã có trong cửa hàng (so nguyên văn, như `@@unique([tenantId, sku])`). */
  takenSkus: ReadonlySet<string>;
}

export interface ParsedProduct {
  /** Các dòng Excel tạo nên hàng hoá này, theo thứ tự. */
  rows: number[];
  dto: CreateProductDto;
}

export interface ParseResult {
  products: ParsedProduct[];
  errors: ImportError[];
}

const COLUMN_BY_KEY = new Map(IMPORT_COLUMNS.map((c) => [c.key, c]));

/** So tên không phân biệt hoa/thường và cách gõ dấu (NFC), bỏ khoảng trắng thừa. */
export function normalizeName(text: string): string {
  return text
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('vi');
}

export function buildNameIndex(
  entries: { id: string; names: string[] }[],
): NameIndex {
  const index: NameIndex = new Map();
  for (const { id, names } of entries) {
    for (const name of new Set(names.map(normalizeName))) {
      if (!name) continue;
      const ids = index.get(name) ?? [];
      if (!ids.includes(id)) ids.push(id);
      index.set(name, ids);
    }
  }
  return index;
}

/** Nội dung ô dưới dạng chữ đã trim; số giữ nguyên chữ số (không có dấu phân cách). */
export function textOf(value: CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? YES : NO;
  return value.normalize('NFC').trim();
}

/**
 * Đọc một số tiền / phần trăm. Ô số của Excel đi thẳng; ô chữ chấp nhận cách viết quen thuộc ở
 * Việt Nam: `1.200.000`, `1,200,000`, `1 200 000đ`, `10%`. Dấu `.` hay `,` chỉ được coi là phân
 * cách hàng nghìn khi đứng trước đúng ba chữ số - `12,5` là mười hai phẩy năm.
 */
export function numberOf(value: CellValue): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let text = textOf(value)
    .replace(/[đ₫%]|vnđ|vnd/gi, '')
    .replace(/\s+/g, '');
  if (!text) return null;
  if (/^-?\d{1,3}([.,]\d{3})+$/.test(text)) {
    text = text.replace(/[.,]/g, '');
  } else if (/^-?\d{1,3}(,\d{3})+\.\d+$/.test(text)) {
    text = text.replace(/,/g, '');
  } else if (/^-?\d{1,3}(\.\d{3})+,\d+$/.test(text)) {
    text = text.replace(/\./g, '').replace(',', '.');
  } else {
    text = text.replace(',', '.');
  }
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
  return Number(text);
}

function hasMoreThanTwoDecimals(n: number): boolean {
  return Math.abs(Math.round(n * 100) - n * 100) > 1e-6;
}

/** Danh sách cách nhau bởi `;` hoặc xuống dòng. Dấu phẩy không tách - tên NCC hay URL có thể chứa nó. */
function listOf(value: CellValue): string[] {
  return textOf(value)
    .split(/[;\n]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

const STATUS_BY_TEXT = new Map<string, string>(
  Object.entries(STATUS_LABELS).flatMap(([status, label]) => [
    [normalizeName(label), status],
    [normalizeName(status), status],
  ]),
);

const ITEM_TYPE_BY_TEXT = new Map<string, string>(
  Object.entries(ITEM_TYPE_LABELS).flatMap(([type, label]) => [
    [normalizeName(label), type],
    [normalizeName(type), type],
  ]),
);

const YES_TEXTS = new Set(['có', 'co', 'yes', 'y', 'x', 'true', '1']);
const NO_TEXTS = new Set(['không', 'khong', 'no', 'n', 'false', '0']);

/** Thông tin cấp hàng hoá đọc từ một dòng - so giữa các dòng của cùng hàng hoá. */
interface ProductFields {
  categoryId?: string;
  brandId?: string;
  status?: string;
  isManufacturable?: boolean;
}

interface ItemDraft {
  row: number;
  item: CreateProductItemDto;
  /** Tên mặt hàng có điền tay không - không thì sinh từ tên hàng hoá + giá trị thuộc tính. */
  explicitName: boolean;
  attributes: { name: string; unit: string; value: string; column: string }[];
}

interface ProductDraft {
  name: string;
  rows: number[];
  fields: ProductFields;
  /** Dòng nào đặt từng trường cấp hàng hoá - để báo "khác với dòng X". */
  fieldRows: Partial<Record<keyof ProductFields, number>>;
  items: ItemDraft[];
}

export function parseImportRows(
  rows: ImportRow[],
  lookups: ImportLookups,
): ParseResult {
  const errors: ImportError[] = [];
  const fail = (row: number, key: ImportColumnKey | null, message: string) =>
    errors.push({
      row,
      column: key ? (COLUMN_BY_KEY.get(key)?.header ?? null) : null,
      message,
    });

  const drafts = new Map<string, ProductDraft>();
  const skuRows = new Map<string, number>();

  for (const { rowNumber, cells } of rows) {
    const text = (key: ImportColumnKey) => textOf(cells[key]);

    const name = text('name');
    if (!name) {
      fail(rowNumber, 'name', 'Tên hàng hóa không được để trống');
      continue;
    }
    const nameKey = normalizeName(name);
    let draft = drafts.get(nameKey);
    if (!draft) {
      if (lookups.takenProductNames.has(nameKey)) {
        fail(
          rowNumber,
          'name',
          `Hàng hóa "${name}" đã có trong cửa hàng - file import chỉ tạo hàng hóa mới`,
        );
      }
      draft = { name, rows: [], fields: {}, fieldRows: {}, items: [] };
      drafts.set(nameKey, draft);
    }
    draft.rows.push(rowNumber);

    // ── Cấp hàng hoá: điền ở dòng đầu là đủ; dòng sau điền thì phải khớp. ──
    const fields = readProductFields(rowNumber, cells, lookups, fail);
    for (const key of Object.keys(fields) as (keyof ProductFields)[]) {
      const value = fields[key];
      if (value === undefined) continue;
      const previous = draft.fields[key];
      if (previous === undefined) {
        (draft.fields as Record<string, unknown>)[key] = value;
        draft.fieldRows[key] = rowNumber;
      } else if (JSON.stringify(previous) !== JSON.stringify(value)) {
        const column = PRODUCT_FIELD_COLUMN[key];
        fail(
          rowNumber,
          column,
          `Khác với dòng ${draft.fieldRows[key]} của cùng hàng hóa "${draft.name}" - chỉ cần điền ở dòng đầu tiên`,
        );
      }
    }

    // ── Cấp mặt hàng (SKU) ──
    const itemDraft = readItem(rowNumber, cells, lookups, fail);
    if (!itemDraft) continue;
    const sku = itemDraft.item.sku;
    if (sku) {
      const earlier = skuRows.get(sku);
      if (earlier !== undefined) {
        fail(rowNumber, 'sku', `SKU "${sku}" trùng với dòng ${earlier}`);
      } else if (lookups.takenSkus.has(sku)) {
        fail(rowNumber, 'sku', `SKU "${sku}" đã có trong cửa hàng`);
      }
      skuRows.set(sku, rowNumber);
    }
    draft.items.push(itemDraft);
  }

  const products: ParsedProduct[] = [];
  for (const draft of drafts.values()) {
    const product = assembleProduct(draft, fail);
    if (product) products.push(product);
  }

  errors.sort((a, b) => (a.row ?? 0) - (b.row ?? 0));
  return { products, errors };
}

const PRODUCT_FIELD_COLUMN: Record<keyof ProductFields, ImportColumnKey> = {
  categoryId: 'category',
  brandId: 'brand',
  status: 'status',
  isManufacturable: 'isManufacturable',
};

type Fail = (row: number, key: ImportColumnKey | null, message: string) => void;

function resolveName(
  index: NameIndex,
  raw: string,
  what: string,
  row: number,
  key: ImportColumnKey,
  fail: Fail,
): string | undefined {
  const ids = index.get(normalizeName(raw));
  if (!ids?.length) {
    fail(row, key, `${what} "${raw}" không có trong cửa hàng`);
    return undefined;
  }
  if (ids.length > 1) {
    fail(
      row,
      key,
      `Có ${ids.length} ${what.toLocaleLowerCase('vi')} cùng tên "${raw}" - đổi tên cho khác nhau rồi thử lại`,
    );
    return undefined;
  }
  return ids[0];
}

function readProductFields(
  row: number,
  cells: ImportRow['cells'],
  lookups: ImportLookups,
  fail: Fail,
): ProductFields {
  const fields: ProductFields = {};

  const category = textOf(cells.category);
  if (category) {
    fields.categoryId = resolveName(
      lookups.categories,
      category,
      'Danh mục',
      row,
      'category',
      fail,
    );
  }
  const brand = textOf(cells.brand);
  if (brand) {
    fields.brandId = resolveName(
      lookups.brands,
      brand,
      'Thương hiệu',
      row,
      'brand',
      fail,
    );
  }
  const status = textOf(cells.status);
  if (status) {
    fields.status = STATUS_BY_TEXT.get(normalizeName(status));
    if (!fields.status) {
      fail(
        row,
        'status',
        `Trạng thái phải là "${Object.values(STATUS_LABELS).join('" hoặc "')}"`,
      );
    }
  }
  const manufacturable = normalizeName(textOf(cells.isManufacturable));
  if (manufacturable) {
    if (YES_TEXTS.has(manufacturable)) fields.isManufacturable = true;
    else if (NO_TEXTS.has(manufacturable)) fields.isManufacturable = false;
    else fail(row, 'isManufacturable', `Chỉ nhận "${YES}" hoặc "${NO}"`);
  }
  return fields;
}

function readMoney(
  cells: ImportRow['cells'],
  key: ImportColumnKey,
  row: number,
  fail: Fail,
): number | undefined {
  const column = COLUMN_BY_KEY.get(key) as ImportColumn;
  const raw = cells[key];
  if (!textOf(raw)) {
    fail(row, key, `${column.header} không được để trống`);
    return undefined;
  }
  const value = numberOf(raw);
  if (value === null) {
    fail(row, key, `${column.header} phải là số (đang là "${textOf(raw)}")`);
    return undefined;
  }
  if (value < 0) {
    fail(row, key, `${column.header} không được âm`);
    return undefined;
  }
  if (hasMoreThanTwoDecimals(value)) {
    fail(row, key, `${column.header} có tối đa 2 chữ số thập phân`);
    return undefined;
  }
  return value;
}

function readItem(
  row: number,
  cells: ImportRow['cells'],
  lookups: ImportLookups,
  fail: Fail,
): ItemDraft | undefined {
  let ok = true;
  const failHere: Fail = (r, k, m) => {
    ok = false;
    fail(r, k, m);
  };

  const retailPrice = readMoney(cells, 'retailPrice', row, failHere);
  const costPrice = readMoney(cells, 'costPrice', row, failHere);

  let vat: number | undefined;
  if (textOf(cells.vat)) {
    const value = numberOf(cells.vat);
    if (value === null || value < 0 || value > 100) {
      failHere(row, 'vat', 'VAT phải là số từ 0 đến 100');
    } else if (hasMoreThanTwoDecimals(value)) {
      failHere(row, 'vat', 'VAT có tối đa 2 chữ số thập phân');
    } else {
      vat = value;
    }
  }

  let itemType: ProductItemType = ProductItemType.PRODUCT;
  const typeText = textOf(cells.itemType);
  if (typeText) {
    const type = ITEM_TYPE_BY_TEXT.get(normalizeName(typeText));
    if (normalizeName(typeText) === normalizeName(ProductItemType.COMBO)) {
      failHere(
        row,
        'itemType',
        'Combo không nhập được bằng file - hãy tạo combo trên màn hình hàng hóa',
      );
    } else if (!type) {
      failHere(
        row,
        'itemType',
        `Loại mặt hàng phải là "${Object.values(ITEM_TYPE_LABELS).join('" hoặc "')}"`,
      );
    } else {
      itemType = type as ProductItemType;
    }
  }

  const supplierIds: string[] = [];
  for (const supplier of listOf(cells.suppliers)) {
    const id = resolveName(
      lookups.suppliers,
      supplier,
      'Nhà cung cấp',
      row,
      'suppliers',
      failHere,
    );
    if (id && !supplierIds.includes(id)) supplierIds.push(id);
  }

  const attributes: ItemDraft['attributes'] = [];
  const seenAttributes = new Set<string>();
  for (let n = 1; n <= IMPORT_ATTRIBUTE_SLOTS; n++) {
    const name = textOf(cells[`attrName${n}`]);
    const unit = textOf(cells[`attrUnit${n}`]);
    const value = textOf(cells[`attrValue${n}`]);
    if (!name && !unit && !value) continue;
    if (!name) {
      failHere(
        row,
        `attrName${n}`,
        `Có giá trị/đơn vị nhưng chưa điền "Thuộc tính ${n}"`,
      );
      continue;
    }
    if (!value) {
      failHere(row, `attrValue${n}`, `Thuộc tính "${name}" chưa có giá trị`);
      continue;
    }
    const key = normalizeName(name);
    if (seenAttributes.has(key)) {
      failHere(
        row,
        `attrName${n}`,
        `Thuộc tính "${name}" bị lặp lại trên cùng một dòng`,
      );
      continue;
    }
    seenAttributes.add(key);
    attributes.push({ name, unit, value, column: `attrName${n}` });
  }

  if (!ok || retailPrice === undefined || costPrice === undefined) {
    return undefined;
  }

  const itemName = textOf(cells.itemName);
  const optional = (key: ImportColumnKey) => textOf(cells[key]) || undefined;
  return {
    row,
    explicitName: Boolean(itemName),
    attributes,
    item: {
      productName: itemName,
      productCode: optional('productCode'),
      sku: optional('sku'),
      barcode: optional('barcode'),
      retailPrice,
      costPrice,
      vat,
      warrantyPeriod: optional('warrantyPeriod'),
      description: optional('description'),
      itemType,
      supplierIds: supplierIds.length ? supplierIds : undefined,
      productDetails: attributes.map(({ name, value }) => ({ name, value })),
    },
  };
}

/** Ghép các dòng của một hàng hoá; kiểm tra các luật chỉ thấy được khi nhìn cả nhóm. */
function assembleProduct(
  draft: ProductDraft,
  fail: Fail,
): ParsedProduct | undefined {
  // Cùng một thuộc tính phải cùng đơn vị - đơn vị thuộc về thuộc tính của hàng hoá, không phải của SKU.
  const units = new Map<string, { unit: string; row: number; name: string }>();
  let ok = true;
  for (const item of draft.items) {
    for (const attr of item.attributes) {
      const key = normalizeName(attr.name);
      const seen = units.get(key);
      if (!seen) {
        units.set(key, { unit: attr.unit, row: item.row, name: attr.name });
      } else if (normalizeName(seen.unit) !== normalizeName(attr.unit)) {
        ok = false;
        fail(
          item.row,
          attr.column.replace('Name', 'Unit') as ImportColumnKey,
          `Đơn vị của "${attr.name}" khác với dòng ${seen.row} ("${seen.unit || 'không có'}")`,
        );
      }
    }
  }

  // Hai dòng giống hệt nhau về thuộc tính và tên là cùng một phiên bản nhập hai lần.
  const signatures = new Map<string, number>();
  for (const item of draft.items) {
    const signature = JSON.stringify([
      normalizeName(item.item.productName),
      item.attributes
        .map((a) => [normalizeName(a.name), normalizeName(a.value)])
        .sort(),
    ]);
    const earlier = signatures.get(signature);
    if (earlier !== undefined && draft.items.length > 1) {
      ok = false;
      fail(
        item.row,
        null,
        `Trùng phiên bản với dòng ${earlier} (cùng tên mặt hàng và giá trị thuộc tính) - các phiên bản phải khác nhau ở ít nhất một thuộc tính`,
      );
    }
    signatures.set(signature, item.row);
  }

  // Một dòng đã lỗi thì hàng hoá không được tạo - nhưng các luật nhóm vẫn chạy ở trên để báo hết một lần.
  if (!ok || draft.items.length !== draft.rows.length) return undefined;

  const items = draft.items.map(({ item, explicitName, attributes }) => ({
    ...item,
    productName: explicitName
      ? item.productName
      : [draft.name, ...attributes.map((a) => a.value)].join(' - '),
  }));

  const { fields } = draft;
  return {
    rows: draft.rows,
    dto: {
      name: draft.name,
      ...fields,
      attributes: [...units.values()].map(({ name, unit }) => ({
        name,
        unit: unit || undefined,
      })),
      items,
    },
  };
}
