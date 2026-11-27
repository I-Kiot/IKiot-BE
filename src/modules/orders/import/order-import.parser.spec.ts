import { buildNameIndex } from '../../../common/excel/import-cells';
import {
  dateOf,
  parseOrderImportRows,
  phoneText,
  staffKeys,
} from './order-import.parser';
import type { OrderImportLookups, OrderImportRow } from './order-import.parser';

const staff = new Map<string, string[]>();
for (const key of staffKeys('Nguyễn Văn A', '0901234567')) {
  staff.set(key, ['U1']);
}

const lookups: OrderImportLookups = {
  branches: buildNameIndex([{ id: 'B1', names: ['CN Hà Nội'] }]),
  staff,
  items: new Map([
    ['SKU-1', { id: 'I1', sellable: true }],
    ['SKU-2', { id: 'I2', sellable: true }],
    ['OLD', { id: 'I3', sellable: false }],
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
