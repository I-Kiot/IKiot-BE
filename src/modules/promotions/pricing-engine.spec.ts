import {
  allocatePerItemDiscount,
  buildCandidateList,
  evaluateEligibility,
  rawDiscount,
  resolveSelectedPromotions,
} from './pricing-engine';
import type { CartContext, CartItem, PricingPromotion } from './pricing-engine';

const NOW = new Date('2026-08-26T10:00:00.000Z');

function promo(over: Partial<PricingPromotion> = {}): PricingPromotion {
  return {
    id: 'promo-1',
    promoName: 'Giảm 10%',
    description: null,
    status: 'ACTIVE',
    startDate: new Date('2026-08-01T00:00:00.000Z'),
    endDate: new Date('2026-09-01T00:00:00.000Z'),
    discountType: 'PERCENT',
    discountValue: 10,
    maxDiscountAmount: null,
    minOrderValue: 0,
    stackable: false,
    usageLimit: null,
    usageLimitPerCustomer: null,
    usedCount: 0,
    branchIds: [],
    applicableRuleType: 'all',
    ruleCategoryIds: [],
    ruleProductItemIds: [],
    ...over,
  };
}

// Line ids are handed out in order, exactly as `buildCartContext` does; pass `lineId` explicitly only when a test is about the id.
let nextLineId = 0;
beforeEach(() => {
  nextLineId = 0;
});

function item(over: Partial<CartItem> = {}): CartItem {
  const quantity = over.quantity ?? 1;
  const unitPrice = over.unitPrice ?? 100_000;
  return {
    lineId: nextLineId++,
    productItemId: 'item-a',
    categoryId: 'cat-1',
    quantity,
    unitPrice,
    lineTotal: quantity * unitPrice,
    ...over,
  };
}

function cart(items: CartItem[], over: Partial<CartContext> = {}): CartContext {
  return {
    branchId: 'branch-1',
    customerId: 'cust-1',
    subtotal: items.reduce((sum, i) => sum + i.lineTotal, 0),
    items,
    ...over,
  };
}

describe('rawDiscount', () => {
  it('caps a percentage discount at maxDiscountAmount', () => {
    const items = [item({ unitPrice: 1_000_000 })];
    expect(
      rawDiscount(
        promo({ discountValue: 50, maxDiscountAmount: 200_000 }),
        items,
      ),
    ).toBe(200_000);
  });

  it('never lets a fixed discount exceed what the matched items are worth', () => {
    // A 100k voucher against a 40k basket must not start paying the customer.
    const items = [item({ unitPrice: 40_000 })];
    expect(
      rawDiscount(
        promo({ discountType: 'FIXED_AMOUNT', discountValue: 100_000 }),
        items,
      ),
    ).toBe(40_000);
  });
});

describe('evaluateEligibility', () => {
  it('accepts a plain active promotion', () => {
    expect(evaluateEligibility(promo(), cart([item()]), NOW).eligible).toBe(
      true,
    );
  });

  it.each([
    ['inactive', promo({ status: 'INACTIVE' })],
    ['not started', promo({ startDate: new Date('2026-09-01T00:00:00.000Z') })],
    ['finished', promo({ endDate: new Date('2026-08-02T00:00:00.000Z') })],
    ['out of uses', promo({ usageLimit: 5, usedCount: 5 })],
    ['for another branch', promo({ branchIds: ['branch-other'] })],
    ['under the minimum', promo({ minOrderValue: 500_000 })],
  ])('rejects a promotion that is %s, with a reason', (_label, p) => {
    const verdict = evaluateEligibility(p, cart([item()]), NOW);
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toBeTruthy();
  });

  it('treats an empty branch list as tenant-wide', () => {
    expect(
      evaluateEligibility(promo({ branchIds: [] }), cart([item()]), NOW)
        .eligible,
    ).toBe(true);
  });

  it('rejects a per-customer-capped promotion on a walk-in cart', () => {
    // Without a customer the cap cannot be enforced, so it must not be waved through - otherwise a once-per-customer voucher works on every anonymous sale.
    const verdict = evaluateEligibility(
      promo({ usageLimitPerCustomer: 1 }),
      cart([item()], { customerId: null }),
      NOW,
    );
    expect(verdict.eligible).toBe(false);
  });

  it('counts what this customer has already used', () => {
    const p = promo({ usageLimitPerCustomer: 2 });
    expect(
      evaluateEligibility(p, cart([item()]), NOW, { 'promo-1': 1 }).eligible,
    ).toBe(true);
    expect(
      evaluateEligibility(p, cart([item()]), NOW, { 'promo-1': 2 }).eligible,
    ).toBe(false);
  });

  it('rejects a promotion that matches nothing in the cart', () => {
    const p = promo({
      applicableRuleType: 'product',
      ruleProductItemIds: ['item-z'],
    });
    expect(evaluateEligibility(p, cart([item()]), NOW).eligible).toBe(false);
  });

  it('matches by category when the rule says so', () => {
    const p = promo({
      applicableRuleType: 'category',
      ruleCategoryIds: ['cat-1'],
    });
    expect(evaluateEligibility(p, cart([item()]), NOW).eligible).toBe(true);
  });
});

describe('allocatePerItemDiscount', () => {
  it('splits a discount in proportion to each line', () => {
    const a = item({ productItemId: 'a', unitPrice: 30_000 });
    const b = item({ productItemId: 'b', unitPrice: 70_000 });
    const perLine = allocatePerItemDiscount([
      { matchedItems: [a, b], discount: 10_000 },
    ]);
    expect(perLine.get(a.lineId)).toBe(3_000);
    expect(perLine.get(b.lineId)).toBe(7_000);
  });

  it('does not multiply the discount when one variant is on several lines', () => {
    // The bug this replaced: keying the allocation by `productItemId` made N lines of the same variant each accumulate their neighbours' share, so ten lines under a 10% promotion came out at 100% off and the order was written at 0đ.
    const lines = Array.from({ length: 10 }, () =>
      item({ productItemId: 'same-sku', unitPrice: 100_000 }),
    );
    const perLine = allocatePerItemDiscount([
      { matchedItems: lines, discount: 100_000 },
    ]);

    const allocated = lines.reduce(
      (sum, line) => sum + (perLine.get(line.lineId) ?? 0),
      0,
    );
    expect(allocated).toBe(100_000);
    for (const line of lines) {
      expect(perLine.get(line.lineId)).toBe(10_000);
    }
  });

  it('never discounts a line past its own price', () => {
    // Two stacked promotions on the same 50k line: 40k + 40k must clamp to 50k, or the order ends up owing the customer money.
    const only = item({ productItemId: 'a', unitPrice: 50_000 });
    const perLine = allocatePerItemDiscount([
      { matchedItems: [only], discount: 40_000 },
      { matchedItems: [only], discount: 40_000 },
    ]);
    expect(perLine.get(only.lineId)).toBe(50_000);
  });
});

describe('resolveSelectedPromotions', () => {
  const items = [item({ productItemId: 'a', unitPrice: 200_000 })];

  it('returns the cart untouched when nothing was selected', () => {
    const result = resolveSelectedPromotions([promo()], [], cart(items), NOW);
    expect(result.totalDiscount).toBe(0);
    expect(result.grandTotal).toBe(200_000);
    expect(result.itemBreakdown).toEqual([
      { productItemId: 'a', discountAmount: 0 },
    ]);
  });

  it('applies one selected promotion', () => {
    const result = resolveSelectedPromotions(
      [promo()],
      ['promo-1'],
      cart(items),
      NOW,
    );
    expect(result.totalDiscount).toBe(20_000);
    expect(result.grandTotal).toBe(180_000);
    expect(result.appliedPromotions).toHaveLength(1);
  });

  it('ignores a duplicate id rather than double-counting it', () => {
    const result = resolveSelectedPromotions(
      [promo()],
      ['promo-1', 'promo-1'],
      cart(items),
      NOW,
    );
    expect(result.totalDiscount).toBe(20_000);
  });

  it('refuses more than two promotions', () => {
    expect(() =>
      resolveSelectedPromotions(
        [promo({ id: 'p1' }), promo({ id: 'p2' }), promo({ id: 'p3' })],
        ['p1', 'p2', 'p3'],
        cart(items),
        NOW,
      ),
    ).toThrow(/At most 2 promotions/);
  });

  it('refuses to combine two promotions unless both are stackable', () => {
    const a = promo({ id: 'p1', stackable: true });
    const b = promo({ id: 'p2', stackable: false });
    expect(() =>
      resolveSelectedPromotions([a, b], ['p1', 'p2'], cart(items), NOW),
    ).toThrow(/stackable/);
  });

  it('stacks two stackable promotions', () => {
    const a = promo({ id: 'p1', stackable: true, discountValue: 10 });
    const b = promo({ id: 'p2', stackable: true, discountValue: 20 });
    const result = resolveSelectedPromotions(
      [a, b],
      ['p1', 'p2'],
      cart(items),
      NOW,
    );
    expect(result.totalDiscount).toBe(60_000);
    expect(result.grandTotal).toBe(140_000);
  });

  it('never discounts the whole cart below zero', () => {
    const a = promo({
      id: 'p1',
      stackable: true,
      discountType: 'FIXED_AMOUNT',
      discountValue: 150_000,
    });
    const b = promo({
      id: 'p2',
      stackable: true,
      discountType: 'FIXED_AMOUNT',
      discountValue: 150_000,
    });
    const result = resolveSelectedPromotions(
      [a, b],
      ['p1', 'p2'],
      cart(items),
      NOW,
    );
    expect(result.grandTotal).toBe(0);
    expect(result.totalDiscount).toBe(200_000);
  });

  it('fails loudly when a selected promotion is unknown', () => {
    expect(() =>
      resolveSelectedPromotions([promo()], ['nope'], cart(items), NOW),
    ).toThrow();
  });

  it('fails loudly when a selected promotion is no longer eligible', () => {
    // Dropping it silently would charge the customer more than the screen showed.
    expect(() =>
      resolveSelectedPromotions(
        [promo({ status: 'INACTIVE' })],
        ['promo-1'],
        cart(items),
        NOW,
      ),
    ).toThrow(/is not eligible/);
  });
});

describe('buildCandidateList', () => {
  it('shows ineligible promotions too, with the reason and a zero preview', () => {
    const entries = buildCandidateList(
      [promo({ id: 'ok' }), promo({ id: 'nope', minOrderValue: 999_999 })],
      cart([item({ productItemId: 'a', unitPrice: 200_000 })]),
      NOW,
    );
    const ok = entries.find((e) => e.promotion.id === 'ok')!;
    const nope = entries.find((e) => e.promotion.id === 'nope')!;

    expect(ok.eligible).toBe(true);
    expect(ok.previewDiscount).toBe(20_000);
    expect(nope.eligible).toBe(false);
    expect(nope.reason).toBeTruthy();
    expect(nope.previewDiscount).toBe(0);
  });
});
