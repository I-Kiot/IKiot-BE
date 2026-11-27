import { buildNameIndex } from '../../../common/excel/import-cells';
import {
  dateOf,
  parseOrderImportRows,
  phoneText,
  staffKeys,
} from './order-import.parser';
import type {
  OrderImportItem,
  OrderImportLookups,
  OrderImportRow,
} from './order-import.parser';

function item(id: string, retailPrice: number): OrderImportItem {
  return {
    id,
    sellable: true,
    itemType: 'PRODUCT',
    retailPrice,
    attributes: [],
    attributeValues: new Map(),
  };
}

const staff = new Map<string, string[]>();
for (const key of staffKeys('Nguyễn Văn A', '0901234567')) {
  staff.set(key, ['U1']);
}

const lookups: OrderImportLookups = {
  branches: buildNameIndex([{ id: 'B1', names: ['CN Hà Nội'] }]),
  staff,
  items: new Map<string, OrderImportItem>([
    ['SKU-1', item('I1', 100_000)],
    ['SKU-2', item('I2', 500_000)],
    ['OLD', { ...item('I3', 1000), sellable: false }],
    [
      'BAN',
      {
        ...item('I4', 2_000_000),
        attributes: [
          { id: 'A-COLOR', name: 'Màu', unit: null },
          { id: 'A-LEN', name: 'Dài', unit: 'cm' },
        ],
        attributeValues: new Map([
          ['A-COLOR', 'Nâu'],
          ['A-LEN', '160'],
        ]),
      },
    ],
    [
      'COMBO',
      {
        ...item('I5', 3_000_000),
        itemType: 'COMBO',
        comboLeafIds: new Set(['I4', 'I1', 'I6']),
      },
    ],
    ['LAP-DAT', { ...item('I6', 200_000), itemType: 'SERVICE' }],
  ]),
  customersByPhone: new Map([
    ['0912345678', { id: 'C1', name: 'Trần Thị B', phone: '0912345678' }],
  ]),
};

let n = 1;
const row = (cells: OrderImportRow['cells']): OrderImportRow => ({
  rowNumber: ++n,
  cells,
});
const head = {
  branch: 'CN Hà Nội',
  fulfillmentType: 'Khách đến lấy',
  assignee: 'Nguyễn Văn A - 0901234567',
};

describe('parseOrderImportRows', () => {
  beforeEach(() => {
    n = 1;
  });

  it('groups lines by group code and builds the POST /orders body', () => {
    const { orders, errors } = parseOrderImportRows(
      [
        row({
          group: 'DH1',
          ...head,
          fulfillmentType: 'Giao tận nơi',
          customerPhone: 912345678, // Excel cắt số 0 đầu
          deliveryAddress: '12 Láng Hạ',
          shippingFee: '50.000',
          deposit: 1_000_000,
          depositMethod: 'Tiền mặt',
          sku: 'SKU-1',
          quantity: 1,
        }),
        row({ group: 'DH1', sku: 'SKU-2', quantity: 2, unitPrice: 800000 }),
        row({ group: 'DH2', ...head, sku: 'SKU-1', quantity: '3' }),
      ],
      lookups,
    );
    expect(errors).toEqual([]);
    expect(orders).toHaveLength(2);
    expect(orders[0].rows).toEqual([2, 3]);
    expect(orders[0].dto).toEqual({
      branchId: 'B1',
      fulfillmentType: 'HOME_DELIVERY',
      assigneeId: 'U1',
      customerId: 'C1',
      // Người nhận / SĐT bỏ trống thì lấy theo khách.
      recipientName: 'Trần Thị B',
      recipientPhone: '0912345678',
      deliveryAddress: '12 Láng Hạ',
      shippingFee: 50000,
      deposit: { type: 'AMOUNT', value: 1_000_000, method: 'CASH' },
      items: [
        { productItemId: 'I1', quantity: 1 },
        { productItemId: 'I2', quantity: 2, unitPrice: 800000 },
      ],
    });
    expect(orders[1].dto).toMatchObject({
      fulfillmentType: 'STORE_PICKUP',
      items: [{ productItemId: 'I1', quantity: 3 }],
    });
    expect(orders[1].dto).not.toHaveProperty('customerId');
    expect(orders[1].dto).not.toHaveProperty('customer');
  });

  it('accepts a staff phone instead of the list label and creates a new customer by name', () => {
    const { orders, errors } = parseOrderImportRows(
      [
        row({
          group: 'X',
          ...head,
          assignee: '0901 234 567',
          customerPhone: '0999888777',
          customerName: 'Khách mới',
          sku: 'SKU-1',
          quantity: 1,
        }),
      ],
      lookups,
    );
    expect(errors).toEqual([]);
    expect(orders[0].dto).toMatchObject({
      assigneeId: 'U1',
      customer: { name: 'Khách mới', phone: '0999888777' },
    });
  });

  it('reports every problem by row and builds no order for a broken group', () => {
    const { orders, errors } = parseOrderImportRows(
      [
        row({
          group: 'A',
          branch: 'CN Không có',
          fulfillmentType: 'Giao tận nơi',
          assignee: 'Ai đó',
          customerPhone: '0999000111',
          sku: 'NOPE',
          quantity: 0,
        }),
        row({ group: 'A', branch: 'CN Hà Nội', sku: 'OLD', quantity: 1 }),
        row({ group: '', sku: 'SKU-1', quantity: 1 }),
        row({
          group: 'B',
          ...head,
          shippingFee: 30000,
          deposit: 1000,
          sku: 'SKU-1',
          quantity: 1.5,
        }),
      ],
      lookups,
    );
    expect(orders).toEqual([]);
    const messages = errors.map((e) => `${e.row}|${e.column}|${e.message}`);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^2\|SKU\|Không tìm thấy mặt hàng có SKU "NOPE"/),
        expect.stringMatching(/^2\|Số lượng\|/),
        expect.stringMatching(/^3\|Chi nhánh\|Chi nhánh khác với dòng 2/),
        expect.stringMatching(/^3\|SKU\|Mặt hàng "OLD" đã ngừng kinh doanh/),
        expect.stringMatching(/^4\|Mã nhóm đơn\|/),
        expect.stringMatching(
          /^2\|Chi nhánh\|Không có chi nhánh "CN Không có"/,
        ),
        expect.stringMatching(
          /^2\|Người phụ trách\|Không tìm thấy nhân viên "Ai đó"/,
        ),
        expect.stringMatching(
          /^2\|Tên khách hàng\|Chưa có khách hàng SĐT 0999000111/,
        ),
        expect.stringMatching(
          /^2\|Địa chỉ giao\|Đơn "A" giao tận nơi còn thiếu/,
        ),
        expect.stringMatching(/^5\|Số lượng\|/),
        expect.stringMatching(
          /^5\|Phí giao hàng\|Khách đến lấy không có phí giao hàng/,
        ),
        expect.stringMatching(
          /^5\|Hình thức cọc\|Có tiền cọc thì phải chọn hình thức cọc/,
        ),
      ]),
    );
  });

  it('refuses the sample rows of the template so nobody imports them by mistake', () => {
    const { orders, errors } = parseOrderImportRows(
      [row({ group: 'MẪU-1', ...head, sku: 'SKU-1', quantity: 1 })],
      lookups,
    );
    expect(orders).toEqual([]);
    expect(errors).toEqual([
      {
        row: 2,
        column: 'Mã nhóm đơn',
        message:
          'Đây là dòng mẫu của file - xoá dòng này (hoặc đổi mã nhóm đơn) trước khi nhập',
      },
    ]);
  });

  it('maps an order discount and a requested date', () => {
    const { orders, errors } = parseOrderImportRows(
      [
        row({
          group: 'D',
          ...head,
          orderDiscount: 20000,
          requestedDeliveryDate: '30/11/2026',
          priority: 'Gấp',
          note: 'Gọi trước',
          sku: 'SKU-1',
          quantity: 1,
          lineDiscount: 5000,
        }),
      ],
      lookups,
    );
    expect(errors).toEqual([]);
    expect(orders[0].dto).toMatchObject({
      discountType: 'ORDER',
      discountValue: 20000,
      requestedDeliveryDate: '2026-11-30',
      priority: 'URGENT',
      note: 'Gọi trước',
      items: [{ productItemId: 'I1', quantity: 1, discountAmount: 5000 }],
    });
  });
});

describe('order discount', () => {
  beforeEach(() => {
    n = 1;
  });
  const order = (orderDiscount: string | number, more = {}) =>
    parseOrderImportRows(
      [
        row({ group: 'P', ...head, orderDiscount, sku: 'SKU-1', quantity: 3 }),
        row({
          group: 'P',
          sku: 'SKU-2',
          quantity: 1,
          unitPrice: 450_000,
          ...more,
        }),
      ],
      lookups,
    );

  it('turns a percentage into an amount on the goods after line discounts', () => {
    // 3 x 100.000 + 450.000 - 50.000 = 700.000; 10% = 70.000.
    const { orders, errors } = order('10%', { lineDiscount: 50_000 });
    expect(errors).toEqual([]);
    expect(orders[0].dto).toMatchObject({
      discountType: 'ORDER',
      discountValue: 70_000,
    });
  });

  it('reads 12,5% the Vietnamese way and rounds to the đồng', () => {
    // 750.000 x 12,5% = 93.750.
    expect(order('12,5%').orders[0].dto.discountValue).toBe(93_750);
  });

  it('refuses a percentage out of range and an amount above the goods', () => {
    expect(order('0%').errors[0].message).toMatch(/lớn hơn 0%/);
    expect(order('120%').errors[0].message).toMatch(/không quá 100%/);
    const { orders, errors } = order(800_000);
    expect(orders).toEqual([]);
    expect(errors[0].column).toBe('Giảm giá đơn');
    expect(errors[0].message).toMatch(/lớn hơn tiền hàng sau giảm dòng/);
  });

  it('does not read a percentage in an amount-only column as đồng', () => {
    const { errors } = order(0, { lineDiscount: '10%' });
    expect(errors[0]).toMatchObject({
      column: 'Giảm giá dòng',
      message: 'Giảm giá dòng chỉ ghi số tiền, không ghi phần trăm',
    });
  });
});

describe('custom-made lines', () => {
  beforeEach(() => {
    n = 1;
  });
  const line = (cells: OrderImportRow['cells']) =>
    parseOrderImportRows(
      [row({ group: 'C', ...head, sku: 'BAN', quantity: 1, ...cells })],
      lookups,
    );

  it('maps attribute names to attribute changes and the rest to extra specs', () => {
    const { orders, errors } = line({
      customSpecs: 'màu: Trắng; Dài: 200 cm\nĐệm: Mút cao su',
      customNote: 'Bo góc tròn',
    });
    expect(errors).toEqual([]);
    expect(orders[0].dto.items[0].customization).toEqual({
      specs: [
        { attributeId: 'A-COLOR', name: 'Màu', value: 'Trắng' },
        { attributeId: 'A-LEN', name: 'Dài', value: '200', unit: 'cm' },
        { name: 'Đệm', value: 'Mút cao su' },
      ],
      note: 'Bo góc tròn',
    });
  });

  it('skips an attribute written with the value the SKU already has, as the form does', () => {
    const { orders } = line({ customSpecs: 'Màu: Nâu; Dài: 180' });
    expect(orders[0].dto.items[0].customization).toEqual({
      specs: [{ attributeId: 'A-LEN', name: 'Dài', value: '180', unit: 'cm' }],
    });
    expect(line({ customSpecs: 'Màu: nâu' }).errors[0].message).toMatch(
      /giống hệt mặt hàng gốc/,
    );
  });

  it('accepts a workshop note alone and leaves plain lines without customization', () => {
    expect(
      line({ customNote: 'Sơn mờ' }).orders[0].dto.items[0].customization,
    ).toEqual({ note: 'Sơn mờ' });
    expect(line({}).orders[0].dto.items[0]).not.toHaveProperty('customization');
  });

  it('reports malformed specs and refuses a combo line', () => {
    const messages = line({
      customSpecs: 'Trắng; Dài:; dài: 1; Dài: 2',
    }).errors.map((e) => e.message);
    expect(messages).toEqual([
      'Thông số "Trắng" phải ghi dạng Tên: giá trị',
      'Thông số "Dài" chưa có giá trị',
      'Thông số "Dài" bị lặp lại trên cùng một dòng',
    ]);
    const combo = parseOrderImportRows(
      [
        row({
          group: 'K',
          ...head,
          sku: 'COMBO',
          quantity: 1,
          customNote: 'x',
        }),
      ],
      lookups,
    );
    expect(combo.orders).toEqual([]);
    expect(combo.errors[0].column).toBe('Ghi chú làm riêng');
    expect(combo.errors[0].message).toMatch(/thêm dòng phụ/);
  });
});

describe('combo component sub-rows', () => {
  beforeEach(() => {
    n = 1;
  });
  const parse = (...sub: OrderImportRow['cells'][]) => {
    n = 1;
    return parseOrderImportRows(
      [
        row({ group: 'K', ...head, sku: 'COMBO', quantity: 2 }),
        ...sub.map((cells) =>
          row({ group: 'K', comboParent: 'COMBO', ...cells }),
        ),
      ],
      lookups,
    );
  };

  it('attaches each sub-row to the combo line above as a component customization', () => {
    const { orders, errors } = parse(
      { sku: 'BAN', customSpecs: 'Màu: Trắng; Đệm: Mút' },
      { sku: 'SKU-1', customNote: 'Sơn mờ' },
    );
    expect(errors).toEqual([]);
    expect(orders[0].rows).toEqual([2, 3, 4]);
    // Dòng phụ không thêm dòng hàng: đơn vẫn một dòng combo.
    expect(orders[0].dto.items).toEqual([
      {
        productItemId: 'I5',
        quantity: 2,
        componentCustomizations: [
          {
            productItemId: 'I4',
            customization: {
              specs: [
                { attributeId: 'A-COLOR', name: 'Màu', value: 'Trắng' },
                { name: 'Đệm', value: 'Mút' },
              ],
            },
          },
          { productItemId: 'I1', customization: { note: 'Sơn mờ' } },
        ],
      },
    ]);
  });

  it('attaches to the nearest matching combo line when the same combo appears twice', () => {
    n = 1;
    const { orders, errors } = parseOrderImportRows(
      [
        row({ group: 'K', ...head, sku: 'COMBO', quantity: 1 }),
        row({ group: 'K', sku: 'COMBO', quantity: 1 }),
        row({ group: 'K', comboParent: 'combo', sku: 'BAN', customNote: 'x' }),
      ],
      lookups,
    );
    expect(errors).toEqual([]);
    expect(orders[0].dto.items[0]).not.toHaveProperty(
      'componentCustomizations',
    );
    expect(orders[0].dto.items[1].componentCustomizations).toHaveLength(1);
  });

  it('reports a sub-row with no combo above it or naming a non-combo line', () => {
    n = 1;
    const { orders, errors } = parseOrderImportRows(
      [
        row({
          group: 'K',
          ...head,
          comboParent: 'COMBO',
          sku: 'BAN',
          customNote: 'x',
        }),
        row({ group: 'K', sku: 'SKU-1', quantity: 1 }),
        row({ group: 'K', comboParent: 'SKU-1', sku: 'BAN', customNote: 'x' }),
      ],
      lookups,
    );
    expect(orders).toEqual([]);
    expect(errors.map((e) => [e.row, e.column])).toEqual([
      [2, 'Thuộc combo'],
      [4, 'Thuộc combo'],
    ]);
    expect(errors[0].message).toMatch(
      /Không thấy dòng combo "COMBO" phía trên/,
    );
    expect(errors[1].message).toMatch(/không phải combo/);
  });

  it('refuses amounts, foreign SKUs, duplicates, services and empty specs on a sub-row', () => {
    const { orders, errors } = parse(
      { sku: 'BAN', quantity: 1, unitPrice: 5, customNote: 'x' },
      { sku: 'SKU-2', customNote: 'x' },
      { sku: 'SKU-1', customNote: 'x' },
      { sku: 'SKU-1', customNote: 'y' },
      { sku: 'LAP-DAT', customNote: 'x' },
      { sku: 'BAN' },
    );
    expect(orders).toEqual([]);
    expect(errors.map((e) => [e.row, e.column, e.message])).toEqual([
      [3, 'Số lượng', expect.stringMatching(/để trống Số lượng/)],
      [3, 'Đơn giá', expect.stringMatching(/để trống Đơn giá/)],
      [4, 'SKU', '"SKU-2" không nằm trong combo "COMBO"'],
      [6, 'SKU', expect.stringMatching(/đã có dòng phụ ở dòng 5/)],
      [7, 'Ghi chú làm riêng', 'Dịch vụ không làm riêng được'],
      [8, 'Thông số làm riêng', expect.stringMatching(/phải có Thông số/)],
    ]);
  });
});

describe('order import cell helpers', () => {
  it('reads dates written the Vietnamese way and rejects impossible ones', () => {
    expect(dateOf('1/2/2026')).toBe('2026-02-01');
    expect(dateOf('2026-02-01')).toBe('2026-02-01');
    expect(dateOf(new Date(Date.UTC(2026, 1, 1)))).toBe('2026-02-01');
    expect(dateOf('31/02/2026')).toBeNull();
    expect(dateOf('mai')).toBeNull();
  });

  it('puts back the leading zero Excel strips from a numeric phone cell', () => {
    expect(phoneText(912345678)).toBe('0912345678');
    expect(phoneText('0912345678')).toBe('0912345678');
  });
});
