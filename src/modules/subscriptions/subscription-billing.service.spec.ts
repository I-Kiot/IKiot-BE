import { SepaySubscriptionService } from './sepay-subscription.service';
import { SubscriptionBillingService } from './subscription-billing.service';

describe('SePay subscription webhook', () => {
  const PLATFORM_ACCOUNT = '0123456789';
  const findInvoice = jest.fn().mockResolvedValue(null);
  const billing = new SubscriptionBillingService(
    { subscriptionInvoice: { findFirst: findInvoice } } as never,
    new SepaySubscriptionService(),
    {} as never,
    {} as never,
  );
  const call = (accounts: { accountNumber?: string; subAccount?: string }) =>
    billing.handleSepayWebhook('key', {
      transferType: 'in',
      content: 'IKMS1A2B3C4D5E',
      transferAmount: 500_000,
      ...accounts,
    });

  beforeEach(() => {
    findInvoice.mockClear();
    process.env.SEPAY_WEBHOOK_API_KEY = 'key';
    process.env.SEPAY_ACCOUNT_NUMBER = PLATFORM_ACCOUNT;
  });
  afterAll(() => {
    delete process.env.SEPAY_WEBHOOK_API_KEY;
    delete process.env.SEPAY_ACCOUNT_NUMBER;
  });

  it("ignores money that reached a shop's account", async () => {
    await call({ accountNumber: '9999999999' });
    expect(findInvoice).not.toHaveBeenCalled();
  });

  it('ignores everything when the platform account is not configured', async () => {
    delete process.env.SEPAY_ACCOUNT_NUMBER;
    await call({ accountNumber: PLATFORM_ACCOUNT });
    expect(findInvoice).not.toHaveBeenCalled();
  });

  it("settles money on the platform's account, however it is written or routed", async () => {
    await call({ accountNumber: '0123 456 789' });
    await call({ accountNumber: '9999999999', subAccount: PLATFORM_ACCOUNT });
    expect(findInvoice).toHaveBeenCalledTimes(2);
  });
});
