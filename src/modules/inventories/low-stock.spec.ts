import { actualStockOf, crossedLowStock } from './low-stock';

const line = (stock: number, minStock: number, lockedStock = 0) => ({
  stock,
  lockedStock,
  minStock,
});

// Luật này quyết định điện thoại quản lý có rung không; lỗi đáng sợ là cảnh báo mỗi lần bán khi tồn đã thấp, khiến kênh bị tắt từ ngày đầu.
describe('crossedLowStock', () => {
  it('fires on the step that lands exactly on the threshold', () => {
    expect(crossedLowStock(line(5, 5), -1)).not.toBeNull();
  });

  it('fires on the step that jumps past the threshold', () => {
    expect(crossedLowStock(line(3, 5), -4)).not.toBeNull();
  });

  it('stays quiet on every later sale below the threshold', () => {
    // Tồn còn 4, ngưỡng 5 - cảnh báo đã gửi lúc đó rồi.
    expect(crossedLowStock(line(3, 5), -1)).toBeNull();
  });

  it('stays quiet while stock is still above the threshold', () => {
    expect(crossedLowStock(line(9, 5), -1)).toBeNull();
  });

  it('stays quiet when stock goes up', () => {
    expect(crossedLowStock(line(2, 5), 10)).toBeNull();
  });

  it('stays quiet when the alert is switched off for that line', () => {
    expect(crossedLowStock(line(0, 0), -5)).toBeNull();
  });

  it('stays quiet when nothing moved', () => {
    expect(crossedLowStock(line(5, 5), 0)).toBeNull();
  });

  it('stays quiet when there is no line to judge', () => {
    expect(crossedLowStock(null, -5)).toBeNull();
  });

  // Ngưỡng so với kệ: hàng đã đóng gói cho đơn không còn bán được.
  it('fires when packing an order takes the shelf through the threshold', () => {
    // Tổng 10, 6 đã đóng gói: kệ từ 8 còn 4, ngưỡng 5.
    expect(crossedLowStock(line(10, 5, 6), -4)).not.toBeNull();
  });

  it('judges the shelf, not the total', () => {
    // Tổng (10) vượt 5, nhưng sau lần bán chỉ còn 5 trên kệ.
    expect(crossedLowStock(line(10, 5, 5), -1)).not.toBeNull();
  });
});

describe('actualStockOf', () => {
  it('is the total less what is packed for orders', () => {
    expect(actualStockOf({ stock: 10, lockedStock: 3 })).toBe(7);
  });
});
