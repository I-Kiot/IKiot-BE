import type { PrismaService } from '../../src/prisma/prisma.service';
import {
  derivePaymentStatus,
  paymentRowsOf,
} from '../../src/modules/orders/payment-status';

/**
 * Các bất biến của sổ tiền (docs/payment-flow.md, CLAUDE.md "Money ledger rules"), kiểm bằng SQL / đọc bảng. Gọi ở cuối mọi suite có đụng tới tiền: `await assertMoneyInvariants(prisma, tenantId)`.
 * Hàm trả danh sách vi phạm rồi `expect` rỗng, nên một suite hỏng báo đủ mọi bất biến vi phạm, không chỉ cái đầu tiên.
 * Phạm vi hiện tại (Phase 1-4: khoản tiền, dòng sổ thu chi, trạng thái thanh toán, sổ SePay); các Phase sau thêm bất biến cho nhật ký doanh thu, công nợ nhà cung cấp tại đây.
 */
/** Kiểm nào có thể bỏ qua. Suite dựng dữ liệu thẳng vào bảng (cọc là một dòng Payment không có dòng sổ, trạng thái thanh toán đặt tay) bỏ hai kiểm phụ thuộc vào việc code đã ghi; các suite dựng bằng route / service (order-journey, smoke, order-cancel…) chạy đủ. */
export interface InvariantOptions {
  skip?: readonly (
    | 'PAID_HAS_CASH_FLOW'
    | 'ORDER_STATUS_DERIVED'
    | 'SEPAY_LEDGER'
    | 'SALES_JOURNAL'
    | 'SUPPLIER_DEBT'
  )[];
}

export async function moneyViolations(
  prisma: PrismaService,
  tenantId: string,
  options: InvariantOptions = {},
): Promise<string[]> {
  const out: string[] = [];
  const skip = new Set(options.skip ?? []);

  // 1. Dòng sổ thu chi của đơn gắn đúng một khoản, `CashFlow.amount = Payment.amount`. Dòng đơn quầy cũ (trước Phase 3, không có Payment) được miễn bởi CHECK NOT VALID.
  const mismatched = await prisma.$queryRaw<{ id: string }[]>`
    SELECT c.id FROM cash_flows c JOIN payments p ON p.id = c.payment_id
    WHERE c.tenant_id = ${tenantId} AND c.amount <> p.amount`;
  for (const row of mismatched) {
    out.push(`cash_flow ${row.id} amount differs from its payment`);
  }

  // 1b. Hướng thu / chi và quỹ nhất quán (CHECK có sẵn, kiểm lại để thấy rõ khi ai đó nới CHECK).
  const badFund = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM cash_flows
    WHERE tenant_id = ${tenantId}
      AND ((fund = 'BANK') <> (payment_method IS DISTINCT FROM 'CASH'))
      AND NOT (fund = 'OWNER' AND payment_method = 'CASH')`;
  for (const row of badFund)
    out.push(`cash_flow ${row.id} has an inconsistent fund`);

  // 2. Mỗi khoản PAID có tiền thật có đúng một dòng sổ, trừ tiền mặt BALANCE shipper còn giữ (REMITTANCE PENDING) và khoản CHANNEL (sàn thu hộ).
  const unbooked = skip.has('PAID_HAS_CASH_FLOW')
    ? []
    : await prisma.$queryRaw<{ id: string }[]>`
    SELECT p.id FROM payments p
    LEFT JOIN cash_flows c ON c.payment_id = p.id
    WHERE p.tenant_id = ${tenantId} AND p.status = 'PAID' AND p.method <> 'CHANNEL'
      AND c.id IS NULL
      AND NOT (p.method = 'CASH' AND p.kind = 'BALANCE' AND p.remittance_status = 'PENDING')`;
  for (const row of unbooked)
    out.push(`payment ${row.id} is PAID but has no cash flow`);

  // 3. `orders.payment_status` bằng quy tắc suy ra (từ Phase 3 đơn quầy cũng có dòng Payment, nên kiểm cả đơn quầy).
  const orders = skip.has('ORDER_STATUS_DERIVED')
    ? []
    : await prisma.order.findMany({
        where: { tenantId },
        select: {
          id: true,
          code: true,
          grandTotal: true,
          depositAmount: true,
          paymentStatus: true,
          payments: { select: { kind: true, status: true, amount: true } },
        },
      });
  for (const order of orders) {
    const derived = derivePaymentStatus(order.grandTotal, paymentRowsOf(order));
    if (derived.status !== order.paymentStatus) {
      out.push(
        `order ${order.code} payment_status ${order.paymentStatus} should be ${derived.status}`,
      );
    }
  }

  // 5. Sổ SePay: mọi dòng tiền về đều có kết cục hợp lệ. Đã chốt (SETTLED*) thì có khoản PAID đúng số tiền thực về; không chốt được (REJECTED / UNMATCHED) thì tiền vẫn vào sổ thu chi đúng một dòng UNALLOCATED_RECEIPT cùng số tiền (quyết định 2026-11-11, D2).
  if (!skip.has('SEPAY_LEDGER')) {
    const unsettled = await prisma.$queryRaw<{ id: string }[]>`
      SELECT s.id FROM sepay_transactions s
      WHERE s.tenant_id = ${tenantId} AND s.outcome IN ('SETTLED', 'SETTLED_LATE', 'SETTLED_PARTIAL')
        AND NOT EXISTS (
          SELECT 1 FROM payments p
          WHERE p.id = s.payment_id AND p.status = 'PAID' AND p.amount = s.amount)`;
    for (const row of unsettled)
      out.push(
        `sepay ledger ${row.id} is settled but its payment is missing or differs`,
      );
    const unbookedMoney = await prisma.$queryRaw<{ id: string }[]>`
      SELECT s.id FROM sepay_transactions s
      WHERE s.tenant_id = ${tenantId} AND s.outcome IN ('REJECTED', 'UNMATCHED')
        AND (SELECT count(*) FROM cash_flows c
             WHERE c.sepay_ledger_id = s.id AND c.category = 'UNALLOCATED_RECEIPT' AND c.amount = s.amount) <> 1`;
    for (const row of unbookedMoney)
      out.push(
        `sepay ledger ${row.id} carries money that is not booked once as UNALLOCATED_RECEIPT`,
      );
    const settledReceipts = await prisma.$queryRaw<{ id: string }[]>`
      SELECT c.id FROM cash_flows c JOIN sepay_transactions s ON s.id = c.sepay_ledger_id
      WHERE c.tenant_id = ${tenantId} AND c.category = 'UNALLOCATED_RECEIPT' AND s.outcome NOT IN ('REJECTED', 'UNMATCHED')`;
    for (const row of settledReceipts)
      out.push(
        `cash_flow ${row.id} books an already settled transfer as unallocated (counted twice)`,
      );
  }

  // 5b. Sổ SePay nền tảng (Phase 5): giao dịch ACTIVATED thì hoá đơn đã PAID với số tiền thực nhận; hoá đơn PAID có đúng một giao dịch ACTIVATED; giao dịch chưa kích hoạt thì hoá đơn không PAID bởi chính nó.
  const activatedUnpaid = await prisma.$queryRaw<{ id: string }[]>`
    SELECT t.id FROM platform_sepay_transactions t
    LEFT JOIN subscription_invoices i ON i.id = t.subscription_invoice_id
    WHERE t.tenant_id = ${tenantId} AND t.outcome = 'ACTIVATED'
      AND (i.id IS NULL OR i.status <> 'PAID' OR i.amount_received IS DISTINCT FROM t.amount)`;
  for (const row of activatedUnpaid)
    out.push(
      `platform ledger ${row.id} is ACTIVATED but its invoice is not PAID with that amount`,
    );
  const doubleActivated = await prisma.$queryRaw<{ id: string }[]>`
    SELECT i.id FROM subscription_invoices i
    WHERE i.tenant_id = ${tenantId}
      AND (SELECT count(*) FROM platform_sepay_transactions t
           WHERE t.subscription_invoice_id = i.id AND t.outcome = 'ACTIVATED') > 1`;
  for (const row of doubleActivated)
    out.push(`invoice ${row.id} was activated by more than one transfer`);

  // 5c. Hoàn tiền (Phase 6): mỗi khoản REFUND PAID trỏ về một khoản đã nhận và có người làm (người bấm hoàn / huỷ / trả hàng).
  const refunds = await prisma.$queryRaw<{ id: string }[]>`
    SELECT p.id FROM payments p
    WHERE p.tenant_id = ${tenantId} AND p.kind = 'REFUND' AND p.status = 'PAID'
      AND (p.refund_of_payment_id IS NULL OR p.created_by IS NULL)`;
  for (const row of refunds)
    out.push(`refund ${row.id} lacks its origin payment or its actor`);

  // 6. Đơn COMPLETED có completed_at (CHECK có sẵn; kiểm lại cho RETURNED, vốn được phép null).
  const noCompletedAt = await prisma.order.count({
    where: { tenantId, status: 'COMPLETED', completedAt: null },
  });
  if (noCompletedAt > 0)
    out.push(`${noCompletedAt} COMPLETED orders lack completed_at`);

  // 6b-8 (Phase 7). Nhật ký doanh thu: đơn COMPLETED có đúng một SALE; RETURN chỉ có ở đơn đã có SALE; Σ dòng = số của bút toán (hàng và giá vốn); Σ dòng hoá đơn = tổng hoá đơn.
  if (!skip.has('SALES_JOURNAL')) {
    const noSale = await prisma.$queryRaw<{ code: string }[]>`
      SELECT o.code FROM orders o
      WHERE o.tenant_id = ${tenantId} AND o.status = 'COMPLETED'
        AND (SELECT count(*) FROM sales_journal_entries e
             WHERE e.order_id = o.id AND e.entry_type = 'SALE') <> 1`;
    for (const row of noSale)
      out.push(
        `order ${row.code} is COMPLETED without exactly one SALE journal entry`,
      );
    const orphanReturn = await prisma.$queryRaw<{ id: string }[]>`
      SELECT e.id FROM sales_journal_entries e
      WHERE e.tenant_id = ${tenantId} AND e.entry_type = 'RETURN'
        AND NOT EXISTS (SELECT 1 FROM sales_journal_entries s
                        WHERE s.order_id = e.order_id AND s.entry_type = 'SALE')`;
    for (const row of orphanReturn)
      out.push(`journal RETURN ${row.id} has no SALE for its order`);
    const badLines = await prisma.$queryRaw<{ id: string }[]>`
      SELECT e.id FROM sales_journal_entries e
      WHERE e.tenant_id = ${tenantId} AND e.entry_type IN ('SALE', 'RETURN')
        AND (e.goods_amount <> COALESCE((SELECT sum(l.amount) FROM sales_journal_lines l WHERE l.entry_id = e.id), 0)
          OR e.cogs_amount <> COALESCE((SELECT sum(l.cogs) FROM sales_journal_lines l WHERE l.entry_id = e.id), 0))`;
    for (const row of badLines)
      out.push(
        `journal entry ${row.id} lines do not add up to its goods / cogs`,
      );
    const badInvoice = await prisma.$queryRaw<{ id: string }[]>`
      SELECT i.id FROM invoices i
      WHERE i.tenant_id = ${tenantId} AND i.status = 'ISSUED'
        AND i.total <> COALESCE((SELECT sum(l.amount) FROM invoice_lines l WHERE l.invoice_id = i.id), 0)`;
    for (const row of badInvoice)
      out.push(`invoice ${row.id} lines do not add up to its total`);
  }

  // 9 (Phase 9). Công nợ nhà cung cấp: outstanding_debt = Σ sổ; dư sau mỗi dòng bằng tổng lũy kế; mỗi lần trả nợ gắn một dòng thu chi SUPPLIER_PAYMENT cùng số tiền.
  if (!skip.has('SUPPLIER_DEBT')) {
    const drift = await prisma.$queryRaw<{ id: string }[]>`
      SELECT s.id FROM suppliers s
      WHERE s.tenant_id = ${tenantId}
        AND s.outstanding_debt <> COALESCE((SELECT sum(e.amount) FROM supplier_debt_entries e WHERE e.supplier_id = s.id), 0)`;
    for (const row of drift)
      out.push(`supplier ${row.id} outstanding_debt differs from its ledger`);
    const badBalance = await prisma.$queryRaw<{ id: string }[]>`
      SELECT e.id FROM supplier_debt_entries e
      WHERE e.tenant_id = ${tenantId}
        AND e.balance_after <> (SELECT sum(p.amount) FROM supplier_debt_entries p
                                WHERE p.supplier_id = e.supplier_id
                                  AND (p.created_at, p.id) <= (e.created_at, e.id))`;
    for (const row of badBalance)
      out.push(`debt entry ${row.id} balance_after is not the running total`);
    const badPayment = await prisma.$queryRaw<{ id: string }[]>`
      SELECT e.id FROM supplier_debt_entries e
      LEFT JOIN cash_flows c ON c.id = e.cash_flow_id
      WHERE e.tenant_id = ${tenantId} AND e.entry_type = 'PAYMENT'
        AND (c.id IS NULL OR c.category <> 'SUPPLIER_PAYMENT' OR c.amount <> -e.amount)`;
    for (const row of badPayment)
      out.push(
        `debt payment ${row.id} has no matching SUPPLIER_PAYMENT cash flow`,
      );
  }

  // 11. Người làm / lúc làm do đúng bước sở hữu chúng ghi.
  const received = await prisma.stockMovementRequest.count({
    where: {
      tenantId,
      status: 'RECEIVED',
      OR: [{ receivedById: null }, { receivedAt: null }],
    },
  });
  if (received > 0)
    out.push(`${received} RECEIVED stock movements lack receiver / time`);
  const cancelled = await prisma.stockMovementRequest.count({
    where: {
      tenantId,
      status: 'CANCELLED',
      OR: [{ cancelledById: null }, { cancelledAt: null }],
    },
  });
  if (cancelled > 0)
    out.push(`${cancelled} CANCELLED stock movements lack canceller / time`);
  const closedDrawer = await prisma.cashDrawerSession.count({
    where: { tenantId, status: 'CLOSED', closedAt: null },
  });
  if (closedDrawer > 0)
    out.push(`${closedDrawer} CLOSED drawer sessions lack closed_at`);

  return out;
}

export async function assertMoneyInvariants(
  prisma: PrismaService,
  tenantId: string,
  options: InvariantOptions = {},
): Promise<void> {
  const violations = await moneyViolations(prisma, tenantId, options);
  if (violations.length > 0) {
    throw new Error(
      `Money invariants violated:\n - ${violations.join('\n - ')}`,
    );
  }
}
