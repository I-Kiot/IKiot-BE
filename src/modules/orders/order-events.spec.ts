import { SystemRole } from '../../common/constants/system-role';
import {
  actorSnapshot,
  diffOrderFields,
  diffOrderLines,
  type LineSnap,
} from './order-events';

describe('diffOrderFields', () => {
  const before = {
    recipientName: 'An',
    note: '',
    shippingFee: { toNumber: () => 50000 },
    requestedDeliveryDate: new Date('2026-11-20T00:00:00Z'),
    discountType: null,
  };
  const fields = [
    'recipientName',
    'note',
    'shippingFee',
    'requestedDeliveryDate',
    'discountType',
  ] as const;

  it('bỏ trường không đổi và trường không được gửi', () => {
    expect(diffOrderFields(before, { recipientName: 'An' }, fields)).toEqual(
      {},
    );
  });

  it('chỉ so các khoá có trong after, đổi Decimal thành số và ngày thành YYYY-MM-DD', () => {
    expect(
      diffOrderFields(
        before,
        {
          recipientName: 'Bình',
          shippingFee: { toNumber: () => 70000 },
          requestedDeliveryDate: new Date('2026-11-25T00:00:00Z'),
        },
        fields,
      ),
    ).toEqual({
      recipientName: { from: 'An', to: 'Bình' },
      shippingFee: { from: 50000, to: 70000 },
      requestedDeliveryDate: { from: '2026-11-20', to: '2026-11-25' },
    });
  });

  it('chuỗi rỗng và null là một: "" thành null, không tính là đổi', () => {
    expect(diffOrderFields(before, { note: '' }, fields)).toEqual({});
    expect(diffOrderFields(before, { discountType: null }, fields)).toEqual({});
    expect(
      diffOrderFields(before, { note: 'giao giờ hành chính' }, fields),
    ).toEqual({
      note: { from: null, to: 'giao giờ hành chính' },
    });
  });

  it('xoá giá trị đang có thì to là null', () => {
    expect(diffOrderFields(before, { recipientName: '  ' }, fields)).toEqual({
      recipientName: { from: 'An', to: null },
    });
  });
});

describe('diffOrderLines', () => {
  const line = (
    id: string,
    sku: string,
    quantity: number,
    unitPrice: number,
  ): LineSnap & { id: string } => ({
    id,
    name: `Sản phẩm ${sku}`,
    sku,
    quantity,
    unitPrice,
  });

  it('không đổi gì thì ba danh sách rỗng', () => {
    const rows = [line('a', 'SOFA', 1, 1000)];
    expect(diffOrderLines(rows, rows)).toEqual({
      added: [],
      removed: [],
      changed: [],
    });
  });

  it('dòng không có id là thêm, dòng mất id là bỏ', () => {
    const result = diffOrderLines(
      [line('a', 'SOFA', 1, 1000), line('b', 'BAN', 2, 500)],
      [
        line('a', 'SOFA', 1, 1000),
        { name: 'Ghế', sku: 'GHE', quantity: 4, unitPrice: 200 },
      ],
    );
    expect(result.added).toEqual([{ name: 'Ghế', sku: 'GHE', quantity: 4 }]);
    expect(result.removed).toEqual([
      { name: 'Sản phẩm BAN', sku: 'BAN', quantity: 2 },
    ]);
    expect(result.changed).toEqual([]);
  });

  it('đổi số lượng hoặc đơn giá chỉ ghi phần đã đổi', () => {
    const result = diffOrderLines(
      [line('a', 'SOFA', 1, 1000), line('b', 'BAN', 2, 500)],
      [line('a', 'SOFA', 3, 1000), line('b', 'BAN', 2, 450)],
    );
    expect(result.changed).toEqual([
      { name: 'Sản phẩm SOFA', sku: 'SOFA', quantity: { from: 1, to: 3 } },
      { name: 'Sản phẩm BAN', sku: 'BAN', unitPrice: { from: 500, to: 450 } },
    ]);
  });

  it('bỏ qua dòng con của combo: chúng co giãn theo combo cha nên không phải thay đổi riêng', () => {
    const combo = line('c', 'COMBO', 1, 9000);
    const child = { ...line('d', 'CHAN', 2, 0), parentItemId: 'c' };
    const result = diffOrderLines(
      [combo, child],
      [
        { ...combo, quantity: 2 },
        { ...child, quantity: 4 },
        {
          name: 'Con mới',
          sku: 'MOI',
          quantity: 1,
          unitPrice: 0,
          parentItemId: 'c',
        },
      ],
    );
    expect(result.changed).toEqual([
      { name: 'Sản phẩm COMBO', sku: 'COMBO', quantity: { from: 1, to: 2 } },
    ]);
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
  });
});

describe('actorSnapshot', () => {
  const base = {
    id: 'u1',
    phoneNumber: '0912345678',
    profileFirstName: 'Lan',
    profileLastName: 'Phạm',
  };

  it('không có người dùng thì để trống hết', () => {
    expect(actorSnapshot(null)).toEqual({
      actorId: null,
      actorName: null,
      actorRole: null,
    });
  });

  it('STAFF lấy tên Role, tên đọc họ trước', () => {
    expect(
      actorSnapshot({
        ...base,
        systemRole: SystemRole.STAFF,
        role: { name: 'Thu ngân' },
      }),
    ).toEqual({ actorId: 'u1', actorName: 'Phạm Lan', actorRole: 'Thu ngân' });
  });

  it('STAFF chưa có Role thì vai trò null', () => {
    expect(
      actorSnapshot({ ...base, systemRole: SystemRole.STAFF, role: null })
        .actorRole,
    ).toBeNull();
  });

  it('chủ shop và admin lấy mã systemRole, thiếu tên thì dùng số điện thoại', () => {
    const owner = actorSnapshot({
      ...base,
      profileFirstName: null,
      profileLastName: null,
      systemRole: SystemRole.TENANT_OWNER,
      role: null,
    });
    expect(owner.actorRole).toBe('TENANT_OWNER');
    expect(owner.actorName).toBe('0912345678');
    expect(
      actorSnapshot({ ...base, systemRole: SystemRole.ADMIN, role: null })
        .actorRole,
    ).toBe('ADMIN');
  });
});
