import {
  OrderPriority,
  OrderStatus,
} from '../../common/constants/order-status';
import { ProductionRequestStatus } from '../../common/constants/production-request-status';
import {
  buildProductionList,
  crossedShortage,
  type DemandLine,
  type RequestLine,
} from './production-list';

const SHOP = 'loc-shop';
const DESK = 'item-desk';
const CABINET = 'item-cabinet';

let seq = 0;
function demand(overrides: Partial<DemandLine> = {}): DemandLine {
  seq += 1;
  return {
    orderItemId: `oi-${seq}`,
    orderId: `o-${seq}`,
    orderCode: `DH${String(seq).padStart(3, '0')}`,
    orderStatus: OrderStatus.CONFIRMED,
    priority: OrderPriority.NORMAL,
    requestedDeliveryDate: null,
    assigneeId: null,
    locationId: SHOP,
    productItemId: CABINET,
    quantity: 1,
    isCustom: false,
    ...overrides,
  };
}

function request(overrides: Partial<RequestLine> = {}): RequestLine {
  return {
    requestId: 'pr-1',
    code: 'YCSX000001',
    status: ProductionRequestStatus.SENT,
    supplierName: 'Xưởng A',
    expectedReadyDate: null,
    locationId: SHOP,
    productItemId: CABINET,
    customOrderItemId: null,
    quantity: 1,
    receivedQuantity: 0,
    ...overrides,
  };
}

const build = (input: Partial<Parameters<typeof buildProductionList>[0]>) =>
  buildProductionList({
    demand: [],
    stock: [],
    customLots: [],
    requests: [],
    ...input,
  });

describe('buildProductionList', () => {
  it('reports the hành trình example: desk in stock, cabinet to be made', () => {
    const rows = build({
      demand: [
        demand({ productItemId: DESK }),
        demand({ productItemId: CABINET }),
      ],
      stock: [{ locationId: SHOP, productItemId: DESK, stock: 10 }],
    });
    const byItem = new Map(rows.map((row) => [row.productItemId, row]));
    expect(byItem.get(DESK)?.shortQuantity).toBe(0);
    expect(byItem.get(CABINET)?.shortQuantity).toBe(1);
  });

  it('groups by SKU across orders, listing every order behind the row', () => {
    const rows = build({
      demand: [demand({ quantity: 2 }), demand({ quantity: 1 })],
      stock: [{ locationId: SHOP, productItemId: CABINET, stock: 1 }],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      demandQuantity: 3,
      stock: 1,
      shortQuantity: 2,
    });
    expect(rows[0].orders).toHaveLength(2);
  });

  it('keeps each location apart', () => {
    const rows = build({
      demand: [demand(), demand({ locationId: 'loc-other' })],
      stock: [{ locationId: SHOP, productItemId: CABINET, stock: 1 }],
    });
    expect(rows.map((row) => [row.locationId, row.shortQuantity])).toEqual(
      expect.arrayContaining([
        [SHOP, 0],
        ['loc-other', 1],
      ]),
    );
  });

  it('does not count a packed order short twice: its goods are in total stock', () => {
    // 1 unit in the shop, already packed (locked) for the PACKED order.
    const rows = build({
      demand: [demand({ orderStatus: OrderStatus.PACKED })],
      stock: [{ locationId: SHOP, productItemId: CABINET, stock: 1 }],
    });
    expect(rows[0].shortQuantity).toBe(0);
  });

  it('subtracts what is on order and what is drafted, separately', () => {
    const rows = build({
      demand: [demand({ quantity: 5 })],
      requests: [
        request({ quantity: 3, receivedQuantity: 1 }),
        request({
          requestId: 'pr-2',
          status: ProductionRequestStatus.DRAFT,
          quantity: 1,
        }),
      ],
    });
    expect(rows[0]).toMatchObject({
      onOrderQuantity: 2,
      draftQuantity: 1,
      shortQuantity: 2,
    });
  });

  it('never reports a negative shortfall', () => {
    const rows = build({
      demand: [demand()],
      requests: [request({ quantity: 4 })],
    });
    expect(rows[0].shortQuantity).toBe(0);
  });

  it('gives a custom piece its own row, covered only by its own lots and requests', () => {
    const custom = demand({ isCustom: true, orderItemId: 'oi-custom' });
    const rows = build({
      demand: [custom, demand()],
      stock: [{ locationId: SHOP, productItemId: CABINET, stock: 2 }],
      customLots: [
        {
          locationId: SHOP,
          productItemId: CABINET,
          orderItemId: 'oi-other-custom',
          remaining: 2,
        },
      ],
    });
    const customRow = rows.find((row) => row.customOrderItemId === 'oi-custom');
    const standardRow = rows.find((row) => row.customOrderItemId === null);
    // The two units in stock are somebody else's custom pieces: nobody here can use them.
    expect(customRow).toMatchObject({ stock: 0, shortQuantity: 1 });
    expect(standardRow).toMatchObject({ stock: 0, shortQuantity: 1 });
  });

  it('counts a custom request only against its own order line', () => {
    const custom = demand({ isCustom: true, orderItemId: 'oi-custom' });
    const rows = build({
      demand: [custom, demand()],
      requests: [request({ customOrderItemId: 'oi-custom' })],
    });
    const customRow = rows.find((row) => row.customOrderItemId === 'oi-custom');
    const standardRow = rows.find((row) => row.customOrderItemId === null);
    expect(customRow?.shortQuantity).toBe(0);
    expect(standardRow?.shortQuantity).toBe(1);
  });

  it('shows a line with no source location chosen as short, with no stock', () => {
    const rows = build({
      demand: [demand({ locationId: null })],
      stock: [{ locationId: SHOP, productItemId: CABINET, stock: 5 }],
    });
    expect(rows[0]).toMatchObject({
      locationId: null,
      stock: 0,
      shortQuantity: 1,
    });
  });

  it('keeps a request with no demand behind it as a row with nothing short', () => {
    const rows = build({ requests: [request()] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ onOrderQuantity: 1, shortQuantity: 0 });
  });

  it('orders by urgency: priority tag, then the delivery date asked for', () => {
    const late = demand({
      productItemId: 'a',
      requestedDeliveryDate: new Date('2026-10-20'),
    });
    const soon = demand({
      productItemId: 'b',
      requestedDeliveryDate: new Date('2026-10-10'),
    });
    const urgent = demand({
      productItemId: 'c',
      priority: OrderPriority.URGENT,
    });
    const rows = build({ demand: [late, soon, urgent] });
    expect(rows.map((row) => row.productItemId)).toEqual(['c', 'b', 'a']);
  });
});

describe('the whole catalogue', () => {
  it('lists catalogue pairs with nothing going on, at zero', () => {
    const rows = build({
      catalogue: [{ locationId: SHOP, productItemId: DESK }],
      stock: [{ locationId: SHOP, productItemId: DESK, stock: 4 }],
    });
    expect(rows).toEqual([
      expect.objectContaining({
        productItemId: DESK,
        stock: 4,
        demandQuantity: 0,
        shortQuantity: 0,
      }),
    ]);
  });

  it('does not duplicate a row the demand already made', () => {
    const rows = build({
      demand: [demand()],
      catalogue: [{ locationId: SHOP, productItemId: CABINET }],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].demandQuantity).toBe(1);
  });

  it('puts short rows first, then rows with orders, then the rest', () => {
    const rows = build({
      demand: [
        demand({ productItemId: 'covered', priority: OrderPriority.URGENT }),
        demand({ productItemId: 'short' }),
      ],
      stock: [{ locationId: SHOP, productItemId: 'covered', stock: 5 }],
      catalogue: [{ locationId: SHOP, productItemId: 'idle' }],
    });
    expect(rows.map((row) => row.productItemId)).toEqual([
      'short',
      'covered',
      'idle',
    ]);
  });
});

describe('crossedShortage', () => {
  it('fires only on the change that opens the gap', () => {
    expect(crossedShortage(0, 1)).toBe(true);
    expect(crossedShortage(1, 2)).toBe(false);
    expect(crossedShortage(1, 0)).toBe(false);
    expect(crossedShortage(0, 0)).toBe(false);
  });
});
