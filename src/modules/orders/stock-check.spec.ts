import {
  OrderItemStatus,
  OrderLineType,
  OrderStatus,
} from '../../common/constants/order-status';
import { StockCheckStatus } from './order-read.constants';
import {
  classifyStock,
  computeStockChecks,
  summarizeStock,
  type StockCheckLine,
} from './stock-check';

describe('classifyStock', () => {
  it('reads ENOUGH when the shelf covers the line', () => {
    expect(classifyStock(3, 5)).toEqual({
      status: StockCheckStatus.ENOUGH,
      stock: 5,
      shortQuantity: 0,
    });
  });

  it('reads ENOUGH when the shelf covers it exactly', () => {
    expect(classifyStock(5, 5).status).toBe(StockCheckStatus.ENOUGH);
  });

  it('reads PARTIAL with what is missing when some of it is there', () => {
    expect(classifyStock(5, 2)).toEqual({
      status: StockCheckStatus.PARTIAL,
      stock: 2,
      shortQuantity: 3,
    });
  });

  it('reads OUT when nothing is on the shelf', () => {
    expect(classifyStock(2, 0)).toEqual({
      status: StockCheckStatus.OUT,
      stock: 0,
      shortQuantity: 2,
    });
  });

  it('never shows a negative shelf', () => {
    expect(classifyStock(1, -3)).toMatchObject({ stock: 0, shortQuantity: 1 });
  });
});

describe('summarizeStock', () => {
  const check = (status: StockCheckStatus) => ({
    status,
    stock: 0,
    shortQuantity: 0,
  });

  it('is the worst line', () => {
    expect(
      summarizeStock([
        check(StockCheckStatus.ENOUGH),
        check(StockCheckStatus.OUT),
        check(StockCheckStatus.PARTIAL),
      ]),
    ).toBe(StockCheckStatus.OUT);
    expect(
      summarizeStock([
        check(StockCheckStatus.ENOUGH),
        check(StockCheckStatus.PARTIAL),
      ]),
    ).toBe(StockCheckStatus.PARTIAL);
  });

  it('ignores lines without a check', () => {
    expect(
      summarizeStock([null, undefined, check(StockCheckStatus.ENOUGH)]),
    ).toBe(StockCheckStatus.ENOUGH);
  });

  it('is null when no line has a check', () => {
    expect(summarizeStock([null, undefined])).toBeNull();
    expect(summarizeStock([])).toBeNull();
  });
});

describe('computeStockChecks', () => {
  const WAREHOUSE = 'loc-warehouse';
  const SHOWROOM = 'loc-showroom';

  const line = (
    id: string,
    over: Partial<StockCheckLine> = {},
  ): StockCheckLine => ({
    id,
    productItemId: 'sku-cabinet',
    sourceLocationId: WAREHOUSE,
    lineType: OrderLineType.PRODUCT,
    status: OrderItemStatus.PENDING,
    quantity: 2,
    ...over,
  });

  /** A stand-in for `prisma.inventory` holding the given rows, counting its queries. */
  function inventoryOf(
    rows: {
      locationId: string;
      productItemId: string;
      stock: number;
      lockedStock: number;
    }[],
  ) {
    const findMany = jest.fn().mockResolvedValue(rows);
    return { reader: { inventory: { findMany } } as never, findMany };
  }

  it('compares each line with on-shelf stock (stock − locked) at its source location', async () => {
    const { reader } = inventoryOf([
      {
        locationId: WAREHOUSE,
        productItemId: 'sku-cabinet',
        stock: 5,
        lockedStock: 4,
      },
    ]);
    const checks = await computeStockChecks(reader, 't1', [
      { status: OrderStatus.CONFIRMED, items: [line('a')] },
    ]);
    expect(checks.get('a')).toEqual({
      status: StockCheckStatus.PARTIAL,
      stock: 1,
      shortQuantity: 1,
    });
  });

  it('reads OUT where the SKU has never been stocked', async () => {
    const { reader } = inventoryOf([]);
    const checks = await computeStockChecks(reader, 't1', [
      { status: OrderStatus.CONFIRMED, items: [line('a')] },
    ]);
    expect(checks.get('a')?.status).toBe(StockCheckStatus.OUT);
  });

  it('counts the line’s own location, not stock elsewhere', async () => {
    const { reader } = inventoryOf([
      {
        locationId: SHOWROOM,
        productItemId: 'sku-cabinet',
        stock: 10,
        lockedStock: 0,
      },
    ]);
    const checks = await computeStockChecks(reader, 't1', [
      { status: OrderStatus.CONFIRMED, items: [line('a')] },
    ]);
    expect(checks.get('a')?.status).toBe(StockCheckStatus.OUT);
  });

  it('shows two unpacked orders wanting the last piece both as ENOUGH', async () => {
    const { reader } = inventoryOf([
      {
        locationId: WAREHOUSE,
        productItemId: 'sku-cabinet',
        stock: 1,
        lockedStock: 0,
      },
    ]);
    const checks = await computeStockChecks(reader, 't1', [
      {
        status: OrderStatus.CONFIRMED,
        items: [line('a', { quantity: 1 })],
      },
      {
        status: OrderStatus.CONFIRMED,
        items: [line('b', { quantity: 1 })],
      },
    ]);
    expect(checks.get('a')?.status).toBe(StockCheckStatus.ENOUGH);
    expect(checks.get('b')?.status).toBe(StockCheckStatus.ENOUGH);
  });

  it('reads ENOUGH for a packed order, whose own goods are among the locked ones', async () => {
    const { reader } = inventoryOf([
      {
        locationId: WAREHOUSE,
        productItemId: 'sku-cabinet',
        stock: 2,
        lockedStock: 2,
      },
    ]);
    const checks = await computeStockChecks(reader, 't1', [
      { status: OrderStatus.PACKED, items: [line('a')] },
      { status: OrderStatus.PICKED_UP, items: [line('b')] },
    ]);
    expect(checks.get('a')).toMatchObject({
      status: StockCheckStatus.ENOUGH,
      shortQuantity: 0,
    });
    expect(checks.get('b')?.status).toBe(StockCheckStatus.ENOUGH);
  });

  it('gives no check to combo / service lines, settled lines, lines with no location, or shipped orders', async () => {
    const { reader, findMany } = inventoryOf([]);
    const checks = await computeStockChecks(reader, 't1', [
      {
        status: OrderStatus.CONFIRMED,
        items: [
          line('combo', { lineType: OrderLineType.COMBO }),
          line('service', { lineType: OrderLineType.SERVICE }),
          line('cancelled', { status: OrderItemStatus.CANCELLED }),
          line('nowhere', { sourceLocationId: null }),
        ],
      },
      { status: OrderStatus.SHIPPING, items: [line('shipped')] },
    ]);
    expect(checks.size).toBe(0);
    // Nothing to check, so not even one query.
    expect(findMany).not.toHaveBeenCalled();
  });

  it('checks combo components on their own', async () => {
    const { reader } = inventoryOf([]);
    const checks = await computeStockChecks(reader, 't1', [
      {
        status: OrderStatus.CONFIRMED,
        items: [line('part', { lineType: OrderLineType.COMBO_COMPONENT })],
      },
    ]);
    expect(checks.has('part')).toBe(true);
  });

  it('reads inventory once for any number of orders', async () => {
    const { reader, findMany } = inventoryOf([]);
    await computeStockChecks(
      reader,
      't1',
      Array.from({ length: 20 }, (_, i) => ({
        status: OrderStatus.CONFIRMED,
        items: [line(`l${i}`, { productItemId: `sku-${i}` })],
      })),
    );
    expect(findMany).toHaveBeenCalledTimes(1);
  });
});
