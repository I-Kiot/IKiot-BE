import {
  deliveryOvershoots,
  nextProductionDeliveryCode,
} from './production-deliveries.service';

describe('deliveryOvershoots', () => {
  const lines = [
    { id: 'a', quantity: 10, receivedQuantity: 4 },
    { id: 'b', quantity: 2, receivedQuantity: 0 },
  ];

  it('lets a short delivery through', () => {
    expect(
      deliveryOvershoots(lines, new Map(), [
        { productionRequestItemId: 'a', quantity: 3 },
      ]),
    ).toEqual([]);
  });

  it('allows exactly what is left', () => {
    expect(
      deliveryOvershoots(lines, new Map(), [
        { productionRequestItemId: 'a', quantity: 6 },
        { productionRequestItemId: 'b', quantity: 2 },
      ]),
    ).toEqual([]);
  });

  it('counts what other notes already announced', () => {
    expect(
      deliveryOvershoots(lines, new Map([['a', 5]]), [
        { productionRequestItemId: 'a', quantity: 2 },
      ]),
    ).toEqual([{ lineId: 'a', room: 1 }]);
  });

  it('reports every line over, never a negative room', () => {
    expect(
      deliveryOvershoots(
        [{ id: 'a', quantity: 3, receivedQuantity: 3 }, ...lines.slice(1)],
        new Map([['a', 1]]),
        [
          { productionRequestItemId: 'a', quantity: 1 },
          { productionRequestItemId: 'b', quantity: 3 },
        ],
      ),
    ).toEqual([
      { lineId: 'a', room: 0 },
      { lineId: 'b', room: 2 },
    ]);
  });
});

describe('nextProductionDeliveryCode', () => {
  it('starts at 1', () => {
    expect(nextProductionDeliveryCode(null)).toBe('PGX000001');
  });
  it('follows the highest code, stepping on retries', () => {
    expect(nextProductionDeliveryCode('PGX000041')).toBe('PGX000042');
    expect(nextProductionDeliveryCode('PGX000041', 3)).toBe('PGX000044');
  });
  it('ignores a code of another shape', () => {
    expect(nextProductionDeliveryCode('YCSX000009')).toBe('PGX000001');
  });
});
