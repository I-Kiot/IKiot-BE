import type { Prisma } from '../../../generated/prisma/client';
import { FlowType } from '../stats/stats.constants';
import { writePaymentCashFlow } from './order-cash-flow';

describe('writePaymentCashFlow', () => {
  const create = jest.fn();
  const tx = { cashFlow: { create } } as unknown as Prisma.TransactionClient;
  const flow = {
    tenantId: 't',
    paymentId: 'p',
    orderId: 'o',
    orderCode: 'ORD1',
    flowType: FlowType.INCOME,
    amount: 700,
    method: 'CASH',
    locationId: 'b',
    createdById: 'u',
    description: 'd',
  };
  const written = () =>
    (create.mock.calls[0] as [{ data: Record<string, unknown> }])[0].data;

  beforeEach(() => create.mockReset());

  it('falls back to the order code, so the ledger filter on ORD finds the row', async () => {
    await writePaymentCashFlow(tx, flow);
    expect(written()).toMatchObject({
      paymentId: 'p',
      flowType: 'INCOME',
      amount: 700,
      paymentMethod: 'CASH',
      paymentReference: 'ORD1',
      sepayTransactionId: null,
    });
  });

  it('keeps the reference and transaction id of a transfer', async () => {
    await writePaymentCashFlow(tx, {
      ...flow,
      paymentReference: 'ORD2',
      sepayTransactionId: 'tx-1',
    });
    expect(written()).toMatchObject({
      paymentReference: 'ORD2',
      sepayTransactionId: 'tx-1',
    });
  });
});
