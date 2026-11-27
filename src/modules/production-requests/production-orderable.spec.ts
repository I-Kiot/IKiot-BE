import {
  OrderPriority,
  OrderStatus,
} from '../../common/constants/order-status';
import { ProductionRequestStatus } from '../../common/constants/production-request-status';
import {
  buildProductionState,
  type DemandLine,
  type RequestLine,
} from './production-list';
import {
  orderableLinesOf,
  type OrderableLineInput,
} from './production-orderable';

const TX = 'loc-tx';
const SOFA = 'item-sofa';
const SENT = ProductionRequestStatus.SENT;
const DRAFT = ProductionRequestStatus.DRAFT;

const demand = (
  id: string,
  quantity: number,
  isCustom = false,
): DemandLine => ({
  orderItemId: id,
  orderId: `o-${id}`,
  orderCode: `DH-${id}`,
  orderStatus: OrderStatus.CONFIRMED,
  priority: OrderPriority.NORMAL,
  requestedDeliveryDate: null,
  assigneeId: null,
  locationId: TX,
  productItemId: SOFA,
  quantity,
  isCustom,
});

const request = (
  code: string,
  status: string,
  quantity: number,
  orderItemId: string | null,
  customOrderItemId: string | null = null,
): RequestLine => ({
  requestId: code,
  code,
  status,
  supplierName: 'Xưởng A',
  expectedReadyDate: null,
  locationId: TX,
  productItemId: SOFA,
  customOrderItemId,
  orderItemId,
  quantity,
  receivedQuantity: 0,
});

const input = (d: DemandLine): OrderableLineInput => ({
  id: d.orderItemId,
  productItemId: d.productItemId,
  sourceLocationId: d.locationId,
  quantity: d.quantity,
  isCustom: d.isCustom,
});

const run = (
  demands: DemandLine[],
  requests: RequestLine[],
  shortOf: (id: string) => number | null,
) =>
  orderableLinesOf(
    demands.map(input),
    shortOf,
    buildProductionState({
      demand: demands,
      stock: [],
      customLots: [],
      requests,
    }),
  );

describe('orderableLinesOf', () => {
  it('A1: an unlinked draft already covers the pooled shortage', () => {
    const lines = run(
      [demand('L1', 1)],
      [request('YCSX000002', DRAFT, 1, null)],
      () => 1,
    );
    expect(lines.get('L1')).toMatchObject({
      orderable: 0,
      coveringRequests: [{ code: 'YCSX000002', openQuantity: 1 }],
    });
  });

  it('B: two orders share one pooled shortage', () => {
    const d1 = demand('L1', 2);
    const d2 = demand('L2', 1);
    const shortOf = (id: string) => (id === 'L1' ? 2 : 1);
    const before = run(
      [d1, d2],
      [request('Y2', DRAFT, 1, null), request('Y3', SENT, 1, 'L1')],
      shortOf,
    );
    expect(before.get('L1')?.orderable).toBe(1);
    expect(before.get('L2')?.orderable).toBe(1);
    const after = run(
      [d1, d2],
      [
        request('Y2', DRAFT, 1, null),
        request('Y3', SENT, 1, 'L1'),
        request('Y4', DRAFT, 1, 'L1'),
      ],
      shortOf,
    );
    expect(after.get('L2')?.orderable).toBe(0);
    expect(after.get('L1')?.orderable).toBe(0);
  });

  it('uses the custom row short for a custom line', () => {
    const lines = run([demand('LC', 2, true)], [], () => null);
    expect(lines.get('LC')).toMatchObject({ need: 2, orderable: 2 });
  });

  it('is unknown for a line that is not in the pool demand', () => {
    const lines = orderableLinesOf(
      [input(demand('LX', 1))],
      () => 1,
      buildProductionState({
        demand: [],
        stock: [],
        customLots: [],
        requests: [],
      }),
    );
    expect(lines.get('LX')?.orderable).toBeNull();
  });

  it('is unknown for a standard line with no stock check', () => {
    const lines = run([demand('L1', 1)], [], () => null);
    expect(lines.get('L1')?.orderable).toBeNull();
  });
});
