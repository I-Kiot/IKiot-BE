import {
  OrderPriority,
  OrderStatus,
} from '../../common/constants/order-status';
import { ProductionRequestStatus } from '../../common/constants/production-request-status';
import {
  buildProductionList,
  buildProductionState,
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
    orderItemId: null,
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
    // 1 đơn vị trong shop, đã đóng gói (khoá) cho đơn PACKED.
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
    // Hai đơn vị trong kho là hàng tuỳ chỉnh của người khác: không ai ở đây dùng được.
    expect(customRow).toMatchObject({ stock: 0, shortQuantity: 1 });
    expect(standardRow).toMatchObject({ stock: 0, shortQuantity: 1 });
  });

  it('counts a custom request only against its own order line', () => {
    const custom = demand({ isCustom: true, orderItemId: 'oi-custom' });
    const rows = build({
      demand: [custom, demand()],
      requests: [
        request({ customOrderItemId: 'oi-custom', orderItemId: 'oi-custom' }),
      ],
    });
    const customRow = rows.find((row) => row.customOrderItemId === 'oi-custom');
    const standardRow = rows.find((row) => row.customOrderItemId === null);
    // Dòng tuỳ chỉnh đã được YCSX của chính nó nhận hết: không còn dòng nào để liệt kê.
    expect(customRow).toBeUndefined();
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

describe('linked requests (2026-11-19)', () => {
  const state = (input: Partial<Parameters<typeof buildProductionList>[0]>) =>
    buildProductionState({
      demand: [],
      stock: [],
      customLots: [],
      requests: [],
      ...input,
    });
  const SOFA = 'item-sofa';
  const line = (
    id: string,
    quantity: number,
    extra: Partial<DemandLine> = {},
  ) =>
    demand({
      orderItemId: id,
      orderCode: `DH-${id}`,
      productItemId: SOFA,
      quantity,
      ...extra,
    });
  const req = (
    code: string,
    status: string,
    quantity: number,
    orderItemId: string | null,
    extra: Partial<RequestLine> = {},
  ) =>
    request({
      requestId: code,
      code,
      status,
      productItemId: SOFA,
      quantity,
      orderItemId,
      ...extra,
    });
  const SENT = ProductionRequestStatus.SENT;
  const DRAFT = ProductionRequestStatus.DRAFT;

  it('A1: an unlinked draft covers the pooled shortage, the line itself is uncovered', () => {
    const { entries, coverage } = state({
      demand: [line('L1', 1)],
      requests: [req('YCSX000002', DRAFT, 1, null)],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      demandQuantity: 1,
      draftQuantity: 1,
      onOrderQuantity: 0,
      shortQuantity: 0,
    });
    expect(entries[0].orders).toMatchObject([
      { quantity: 1, remainingQuantity: 1, coveredQuantity: 0 },
    ]);
    expect(entries[0].requests.map((r) => r.code)).toEqual(['YCSX000002']);
    expect(coverage.get('L1')?.coveredQuantity).toBe(0);
  });

  it('A2: a linked SENT request consumes the line, the unlinked draft stays visible', () => {
    const { entries, coverage } = state({
      demand: [line('L1', 1)],
      requests: [
        req('YCSX000002', DRAFT, 1, null),
        req('YCSX000003', SENT, 1, 'L1'),
      ],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      demandQuantity: 0,
      onOrderQuantity: 0,
      draftQuantity: 1,
      shortQuantity: 0,
    });
    expect(entries[0].orders).toEqual([]);
    expect(entries[0].requests.map((r) => r.code)).toEqual(['YCSX000002']);
    expect(coverage.get('L1')).toMatchObject({
      coveredQuantity: 1,
      remainingQuantity: 0,
    });
  });

  it('B: partial coverage across two orders keeps coveredBy and the pooled short', () => {
    const { entries } = state({
      demand: [line('L1', 2, { priority: OrderPriority.HIGH }), line('L2', 1)],
      requests: [
        req('YCSX000002', DRAFT, 1, null),
        req('YCSX000003', SENT, 1, 'L1'),
      ],
    });
    expect(entries[0]).toMatchObject({
      demandQuantity: 2,
      onOrderQuantity: 0,
      draftQuantity: 1,
      shortQuantity: 1,
    });
    const l1 = entries[0].orders.find((o) => o.orderItemId === 'L1');
    expect(l1).toMatchObject({
      quantity: 2,
      remainingQuantity: 1,
      coveredQuantity: 1,
    });
    expect(l1?.coveredBy).toMatchObject([{ code: 'YCSX000003', quantity: 1 }]);
    expect(
      entries[0].orders.find((o) => o.orderItemId === 'L2')?.remainingQuantity,
    ).toBe(1);
  });

  it('keeps shortQuantity per row identical to the result with no links', () => {
    const demands = [line('L1', 2), line('L2', 1)];
    const linked = [req('Y3', SENT, 1, 'L1'), req('Y2', DRAFT, 1, null)];
    const unlinked = linked.map((r) => ({ ...r, orderItemId: null }));
    const a = state({ demand: demands, requests: linked }).entries;
    const b = state({ demand: demands, requests: unlinked }).entries;
    expect(a[0].shortQuantity).toBe(b[0].shortQuantity);
    const stock = [{ locationId: SHOP, productItemId: SOFA, stock: 1 }];
    const c = state({
      demand: [line('L', 3)],
      stock,
      requests: [req('Y', SENT, 3, 'L', { receivedQuantity: 2 })],
    }).entries;
    const d = state({
      demand: [line('L', 3)],
      stock,
      requests: [req('Y', SENT, 3, null, { receivedQuantity: 2 })],
    }).entries;
    expect(c[0].shortQuantity).toBe(d[0].shortQuantity);
  });

  it('caps coverage at the line quantity; the rest stays pooled supply', () => {
    const { entries, coverage } = state({
      demand: [line('L1', 1), line('L2', 2)],
      requests: [req('Y1', SENT, 3, 'L1')],
    });
    expect(coverage.get('L1')?.coveredQuantity).toBe(1);
    expect(entries[0]).toMatchObject({
      demandQuantity: 2,
      onOrderQuantity: 2,
      shortQuantity: 0,
    });
    expect(entries[0].requests[0].outstanding).toBe(2);
  });

  it('D: a request delivering to another location does not cover the line', () => {
    const { entries, coverage } = state({
      demand: [line('L', 1, { locationId: 'loc-wh' })],
      requests: [req('Y1', SENT, 1, 'L', { locationId: SHOP })],
    });
    expect(coverage.get('L')?.coveredQuantity).toBe(0);
    const wh = entries.find((r) => r.locationId === 'loc-wh');
    const tx = entries.find((r) => r.locationId === SHOP);
    expect(wh).toMatchObject({ shortQuantity: 1 });
    expect(tx).toMatchObject({ onOrderQuantity: 1 });
  });

  it('drops the row when its only content is a covered line and its request', () => {
    expect(
      state({
        demand: [line('L', 1)],
        requests: [req('Y1', SENT, 1, 'L')],
      }).entries,
    ).toEqual([]);
    const custom = state({
      demand: [line('LC', 1, { isCustom: true })],
      requests: [req('Y1', SENT, 1, 'LC', { customOrderItemId: 'LC' })],
    }).entries;
    expect(custom).toEqual([]);
  });

  it('C: a partly received linked request covers only what is still outstanding', () => {
    const { entries, coverage } = state({
      demand: [line('L', 3)],
      stock: [{ locationId: SHOP, productItemId: SOFA, stock: 1 }],
      requests: [req('Y1', SENT, 3, 'L', { receivedQuantity: 2 })],
    });
    expect(coverage.get('L')).toMatchObject({
      coveredQuantity: 1,
      remainingQuantity: 2,
    });
    expect(entries[0]).toMatchObject({
      stock: 1,
      demandQuantity: 2,
      onOrderQuantity: 0,
      shortQuantity: 1,
    });
  });

  it('two linked requests on a qty-1 line: the oldest consumes, the next stays pooled', () => {
    const { entries, coverage } = state({
      demand: [line('L', 1)],
      requests: [req('Y1', SENT, 1, 'L'), req('Y2', DRAFT, 1, 'L')],
    });
    expect(coverage.get('L')?.coveredBy.map((c) => c.code)).toEqual(['Y1']);
    expect(entries[0].requests.map((r) => r.code)).toEqual(['Y2']);
    expect(entries[0]).toMatchObject({ draftQuantity: 1, demandQuantity: 0 });
  });
});
