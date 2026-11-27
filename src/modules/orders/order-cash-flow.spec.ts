import type { Prisma } from '../../../generated/prisma/client';
import { CashFlowCategory } from '../../common/constants/cash-flow-category';
import { writePaymentCashFlow } from './order-cash-flow';

describe('writePaymentCashFlow', () => {
  const create = jest.fn();
  const tx = { cashFlow: { create } } as unknown as Prisma.TransactionClient;
  const flow = {
    tenantId: 't',
    payment: { id: 'p', amount: 700, method: 'CASH' },
    category: CashFlowCategory.ORDER_PAYMENT,
    orderId: 'o',
    orderCode: 'ORD1',
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
      category: 'ORDER_PAYMENT',
      fund: 'DRAWER',
      amount: 700,
      paymentMethod: 'CASH',
      paymentReference: 'ORD1',
      sepayTransactionId: null,
    });
  });

  it('takes the amount from the payment row, rounded to đồng', async () => {
    await writePaymentCashFlow(tx, {
      ...flow,
      payment: { id: 'p', amount: { toNumber: () => 700.4 }, method: 'CASH' },
    });
    expect(written().amount).toBe(700);
  });

  it('derives an expense from a refund category', async () => {
    await writePaymentCashFlow(tx, {
      ...flow,
      category: CashFlowCategory.ORDER_REFUND,
    });
    expect(written()).toMatchObject({ flowType: 'EXPENSE', fund: 'DRAWER' });
  });

  it('books a non-cash payment to the bank fund', async () => {
    await writePaymentCashFlow(tx, {
      ...flow,
      payment: { id: 'p', amount: 700, method: 'SEPAY' },
    });
    expect(written().fund).toBe('BANK');
  });

  it('books cash handed straight to the owner to the OWNER fund, still attributed to the branch', async () => {
    await writePaymentCashFlow(tx, { ...flow, handedToOwner: true });
    expect(written()).toMatchObject({ fund: 'OWNER', locationId: 'b' });
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
