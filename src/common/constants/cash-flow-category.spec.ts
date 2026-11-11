import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import {
  CASH_FLOW_CATEGORIES,
  CASH_FLOW_FUNDS,
  CashFlowCategory,
  CashFlowFund,
  flowTypeOf,
  fundOf,
} from './cash-flow-category';
import { FlowType } from '../../modules/stats/stats.constants';

const MIGRATIONS = join(__dirname, '../../../prisma/migrations');

/** Danh sách trong CHECK mới nhất của một ràng buộc (migration sau ghi đè migration trước). */
function checkList(constraint: string, column: string): string[] {
  const folders = readdirSync(MIGRATIONS)
    .filter((f) => /^\d{14}_/.test(f))
    .sort();
  let found: string[] | null = null;
  for (const folder of folders) {
    const sql = readFileSync(join(MIGRATIONS, folder, 'migration.sql'), 'utf8');
    const match = new RegExp(
      `ADD CONSTRAINT "${constraint}" CHECK \\("${column}" IN \\(([^)]*)\\)`,
    ).exec(sql);
    if (match) {
      found = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    }
  }
  if (!found) throw new Error(`No migration defines ${constraint}`);
  return found;
}

describe('cash flow category / fund', () => {
  it('matches the CHECK lists in the latest migration', () => {
    expect([...CASH_FLOW_CATEGORIES].sort()).toEqual(
      checkList('cash_flows_category_check', 'category').sort(),
    );
    expect([...CASH_FLOW_FUNDS].sort()).toEqual(
      checkList('cash_flows_fund_check', 'fund').sort(),
    );
  });

  it('derives the direction from the category', () => {
    expect(flowTypeOf(CashFlowCategory.ORDER_PAYMENT)).toBe(FlowType.INCOME);
    expect(flowTypeOf(CashFlowCategory.UNALLOCATED_RECEIPT)).toBe(
      FlowType.INCOME,
    );
    for (const expense of [
      CashFlowCategory.ORDER_REFUND,
      CashFlowCategory.SALE_CHANGE,
      CashFlowCategory.SUPPLIER_PAYMENT,
      CashFlowCategory.UNALLOCATED_REFUND,
    ]) {
      expect(flowTypeOf(expense)).toBe(FlowType.EXPENSE);
    }
  });

  it('puts cash in the drawer, remitted cash with the owner, the rest in the bank', () => {
    expect(fundOf('CASH')).toBe(CashFlowFund.DRAWER);
    expect(fundOf('CASH', { toOwner: true })).toBe(CashFlowFund.OWNER);
    for (const method of ['SEPAY', 'BANK_TRANSFER', 'MOMO', 'VNPAY', null]) {
      expect(fundOf(method)).toBe(CashFlowFund.BANK);
      expect(fundOf(method, { toOwner: true })).toBe(CashFlowFund.BANK);
    }
  });
});

describe('cash flow writers', () => {
  it('only order-cash-flow.ts and suppliers.service.ts create cash flows', () => {
    // Một nơi ghi dòng tiền của đơn và tiền SePay chưa gắn đơn (`writePaymentCashFlow`, `writeUnallocatedCashFlow`) và một nơi cho nhà cung cấp. Đơn quầy hết ghi trực tiếp từ Phase 3: nó cũng có Payment.
    const allowed = new Set([
      'modules/orders/order-cash-flow.ts',
      'modules/suppliers/suppliers.service.ts',
    ]);
    const root = join(__dirname, '..', '..');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (
          entry.name.endsWith('.ts') &&
          !entry.name.endsWith('.spec.ts')
        ) {
          const text = readFileSync(full, 'utf8');
          if (/cashFlow\.create/.test(text)) {
            const rel = full.slice(root.length + 1).replace(/\\/g, '/');
            if (!allowed.has(rel)) offenders.push(rel);
          }
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
