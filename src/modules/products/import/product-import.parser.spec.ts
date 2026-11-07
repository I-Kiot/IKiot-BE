import {
  buildNameIndex,
  numberOf,
  parseImportRows,
} from './product-import.parser';
import type { ImportLookups, ImportRow } from './product-import.parser';

const lookups = (over: Partial<ImportLookups> = {}): ImportLookups => ({
  categories: buildNameIndex([
    { id: 'cat-ban', names: ['Bàn', 'Nội thất > Bàn'] },
    { id: 'cat-ban-2', names: ['Bàn', 'Ngoài trời > Bàn'] },
    { id: 'cat-ghe', names: ['Ghế', 'Ghế'] },
  ]),
  brands: buildNameIndex([{ id: 'brand-1', names: ['Hòa Phát'] }]),
  suppliers: buildNameIndex([
    { id: 'sup-1', names: ['Xưởng A'] },
    { id: 'sup-2', names: ['NCC B'] },
  ]),
  takenProductNames: new Set(),
  takenSkus: new Set(),
  takenProductCodes: new Set(),
  takenBarcodes: new Set(),
  ...over,
});

// Typed wrappers: jest's asymmetric matchers are `any`, which the lint config refuses to assign.
const anyText = () => expect.any(String) as string;
const containing = (text: string) => expect.stringContaining(text) as string;
const arrayContaining = <T>(items: T[]) => expect.arrayContaining(items) as T[];

let rowNumber = 1;
const row = (cells: ImportRow['cells']): ImportRow => ({
  rowNumber: ++rowNumber,
  cells,
});

beforeEach(() => {
  rowNumber = 1;
});

describe('numberOf', () => {
  it.each([
    [1200000, 1200000],
    ['1.200.000', 1200000],
    ['1,200,000', 1200000],
    ['1 200 000đ', 1200000],
    ['12,5', 12.5],
    ['10%', 10],
    ['1,234.5', 1234.5],
    ['1.234,5', 1234.5],
    ['abc', null],
    ['', null],
  ])('%p → %p', (input, expected) => {
    expect(numberOf(input)).toBe(expected);
  });
});

describe('parseImportRows', () => {
  it('groups rows by product name into one product with several variants', () => {
    const { products, errors } = parseImportRows(
      [
        row({
          name: 'Bàn gỗ sồi',
          category: 'Nội thất > Bàn',
          brand: 'hòa phát',
          isManufacturable: 'Có',
          retailPrice: 3500000,
          costPrice: '2.400.000',
          attrName1: 'Màu',
          attrValue1: 'Nâu',
          attrName2: 'Dài',
          attrUnit2: 'cm',
          attrValue2: 120,
          suppliers: 'Xưởng A; NCC B',
        }),
        row({
          name: '  bàn gỗ  SỒI ',
          retailPrice: 3600000,
          costPrice: 0,
          attrName1: 'Màu',
          attrValue1: 'Trắng',
          attrName2: 'Dài',
          attrUnit2: 'cm',
          attrValue2: 120,
        }),
      ],
      lookups(),
    );

    expect(errors).toEqual([]);
    expect(products).toHaveLength(1);
    const [{ dto, rows }] = products;
    expect(rows).toEqual([2, 3]);
    expect(dto).toMatchObject({
      name: 'Bàn gỗ sồi',
      categoryId: 'cat-ban',
      brandId: 'brand-1',
      isManufacturable: true,
      attributes: [
        { name: 'Màu', unit: undefined },
        { name: 'Dài', unit: 'cm' },
      ],
    });
    expect(dto.items.map((i) => i.productName)).toEqual([
      'Bàn gỗ sồi - Nâu - 120',
      'Bàn gỗ sồi - Trắng - 120',
    ]);
    expect(dto.items[0]).toMatchObject({
      retailPrice: 3500000,
      costPrice: 2400000,
      supplierIds: ['sup-1', 'sup-2'],
      productDetails: [
        { name: 'Màu', value: 'Nâu' },
        { name: 'Dài', value: '120' },
      ],
    });
  });

  it('reports every problem with its row and column instead of stopping at the first', () => {
    const { errors } = parseImportRows(
      [
        row({ retailPrice: 1, costPrice: 1 }),
        row({ name: 'Ghế', retailPrice: 'abc', costPrice: -1 }),
        row({
          name: 'Tủ',
          retailPrice: 1,
          costPrice: 1,
          vat: 150,
          productType: 'Combo',
          category: 'Bàn',
          brand: 'Không có',
          status: 'Bán',
          attrValue1: 'Đỏ',
        }),
      ],
      lookups(),
    );

    expect(errors).toEqual(
      arrayContaining([
        { row: 2, column: 'Tên hàng hóa', message: anyText() },
        { row: 3, column: 'Giá bán', message: containing('số') },
        { row: 3, column: 'Giá vốn', message: containing('âm') },
        { row: 4, column: 'VAT (%)', message: anyText() },
        {
          row: 4,
          column: 'Loại hàng hóa',
          message: containing('Combo'),
        },
        // "Bàn" names two categories - ambiguous, must use the path.
        {
          row: 4,
          column: 'Danh mục',
          message: containing('cùng tên'),
        },
        { row: 4, column: 'Thương hiệu', message: anyText() },
        { row: 4, column: 'Trạng thái', message: anyText() },
        { row: 4, column: 'Thuộc tính 1', message: anyText() },
      ]),
    );
  });

  it('refuses SKUs duplicated in the file or already in the shop, and names already in the shop', () => {
    const { errors } = parseImportRows(
      [
        row({
          name: 'A',
          sku: 'X1',
          retailPrice: 1,
          costPrice: 1,
          attrName1: 'M',
          attrValue1: '1',
        }),
        row({
          name: 'A',
          sku: 'X1',
          retailPrice: 1,
          costPrice: 1,
          attrName1: 'M',
          attrValue1: '2',
        }),
        row({ name: 'B', sku: 'TAKEN', retailPrice: 1, costPrice: 1 }),
        row({ name: 'Cũ', retailPrice: 1, costPrice: 1 }),
      ],
      lookups({
        takenSkus: new Set(['TAKEN']),
        takenProductNames: new Set(['cũ']),
      }),
    );
    expect(errors).toEqual([
      { row: 3, column: 'SKU', message: 'SKU "X1" trùng với dòng 2' },
      { row: 4, column: 'SKU', message: 'SKU "TAKEN" đã có trong cửa hàng' },
      {
        row: 5,
        column: 'Tên hàng hóa',
        message: containing('đã có'),
      },
    ]);
  });

  it('refuses product codes duplicated in the file or already in the shop', () => {
    const { errors } = parseImportRows(
      [
        row({
          name: 'A',
          productCode: 'MA1',
          retailPrice: 1,
          costPrice: 1,
          attrName1: 'M',
          attrValue1: '1',
        }),
        row({
          name: 'A',
          productCode: 'MA1',
          retailPrice: 1,
          costPrice: 1,
          attrName1: 'M',
          attrValue1: '2',
        }),
        row({
          name: 'B',
          productCode: 'SP000001',
          retailPrice: 1,
          costPrice: 1,
        }),
        row({ name: 'C', retailPrice: 1, costPrice: 1 }),
      ],
      lookups({ takenProductCodes: new Set(['SP000001']) }),
    );
    expect(errors).toEqual([
      { row: 3, column: 'Mã hàng', message: 'Mã hàng "MA1" trùng với dòng 2' },
      {
        row: 4,
        column: 'Mã hàng',
        message: 'Mã hàng "SP000001" đã có trong cửa hàng',
      },
    ]);
  });

  it('refuses barcodes duplicated in the file or already in the shop, and lets blank ones repeat', () => {
    const { errors } = parseImportRows(
      [
        row({ name: 'A', barcode: '893001', retailPrice: 1, costPrice: 1 }),
        row({ name: 'B', barcode: '893001', retailPrice: 1, costPrice: 1 }),
        row({ name: 'C', barcode: '893999', retailPrice: 1, costPrice: 1 }),
        row({ name: 'D', retailPrice: 1, costPrice: 1 }),
        row({ name: 'E', retailPrice: 1, costPrice: 1 }),
      ],
      lookups({ takenBarcodes: new Set(['893999']) }),
    );
    expect(errors).toEqual([
      {
        row: 3,
        column: 'Mã vạch',
        message: 'Mã vạch "893001" trùng với dòng 2',
      },
      {
        row: 4,
        column: 'Mã vạch',
        message: 'Mã vạch "893999" đã có trong cửa hàng',
      },
    ]);
  });

  it('rejects conflicting product-level fields and attribute units across rows of one product', () => {
    const { errors } = parseImportRows(
      [
        row({
          name: 'A',
          category: 'Ghế',
          retailPrice: 1,
          costPrice: 1,
          attrName1: 'Dài',
          attrUnit1: 'cm',
          attrValue1: '1',
        }),
        row({
          name: 'A',
          category: 'Nội thất > Bàn',
          retailPrice: 1,
          costPrice: 1,
          attrName1: 'Dài',
          attrUnit1: 'm',
          attrValue1: '2',
        }),
      ],
      lookups(),
    );
    expect(errors).toEqual([
      {
        row: 3,
        column: 'Danh mục',
        message: containing('dòng 2'),
      },
      {
        row: 3,
        column: 'Đơn vị 1',
        message: containing('dòng 2'),
      },
    ]);
  });

  it('rejects two variants that are indistinguishable', () => {
    const { errors, products } = parseImportRows(
      [
        row({
          name: 'A',
          retailPrice: 1,
          costPrice: 1,
          attrName1: 'Màu',
          attrValue1: 'Đỏ',
        }),
        row({
          name: 'A',
          retailPrice: 2,
          costPrice: 1,
          attrName1: 'màu',
          attrValue1: 'đỏ',
        }),
      ],
      lookups(),
    );
    expect(errors).toEqual([
      { row: 3, column: null, message: containing('dòng 2') },
    ]);
    expect(products).toEqual([]);
  });

  it('keeps one type per product: blank means PRODUCT, a later row naming another type is an error', () => {
    const { products, errors } = parseImportRows(
      [
        row({ name: 'Kệ', retailPrice: 1, costPrice: 1 }),
        row({
          name: 'Bàn',
          retailPrice: 1,
          costPrice: 1,
          attrName1: 'Màu',
          attrValue1: 'Nâu',
        }),
        row({
          name: 'Bàn',
          productType: 'Dịch vụ',
          retailPrice: 1,
          costPrice: 1,
          attrName1: 'Màu',
          attrValue1: 'Trắng',
        }),
      ],
      lookups(),
    );
    expect(products[0].dto.productType).toBe('PRODUCT');
    expect(errors).toEqual([]);
    // Dòng đầu bỏ trống thì dòng sau được đặt loại; chỉ khi hai dòng ghi khác nhau mới lỗi.
    expect(products[1].dto.productType).toBe('SERVICE');

    const mixed = parseImportRows(
      [
        row({
          name: 'Bàn',
          productType: 'Hàng hóa',
          retailPrice: 1,
          costPrice: 1,
          attrName1: 'Màu',
          attrValue1: 'Nâu',
        }),
        row({
          name: 'Bàn',
          productType: 'Dịch vụ',
          retailPrice: 1,
          costPrice: 1,
          attrName1: 'Màu',
          attrValue1: 'Trắng',
        }),
      ],
      lookups(),
    );
    expect(mixed.errors).toEqual([
      {
        row: expect.any(Number) as number,
        column: 'Loại hàng hóa',
        message: containing('Khác với dòng'),
      },
    ]);
  });

  it('maps labels for status and product type, and leaves blank codes for the server to allocate', () => {
    const { products, errors } = parseImportRows(
      [
        row({
          name: 'Lắp đặt',
          status: 'Ngừng kinh doanh',
          productType: 'Dịch vụ',
          retailPrice: 200000,
          costPrice: 0,
        }),
      ],
      lookups(),
    );
    expect(errors).toEqual([]);
    expect(products[0].dto).toMatchObject({
      status: 'INACTIVE',
      productType: 'SERVICE',
    });
    expect(products[0].dto.items[0]).not.toHaveProperty('itemType');
    expect(products[0].dto.items[0]).toMatchObject({
      productName: 'Lắp đặt',
      productCode: undefined,
      sku: undefined,
    });
  });
});
