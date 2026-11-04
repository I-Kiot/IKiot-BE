import { FlowType } from '../stats/stats.constants';

/** Phép tính đằng sau “két bị hụt”, thuần để test không cần DB. Mỗi đoạn kiểm bằng `counted − (số đếm trước + tiền mặt thuần ở giữa)`, nên tổng chênh các đoạn bằng chênh của phiên: chỉ ra ngày hụt và ca làm mất. Chỉ tiền mặt; caller tự lọc. */

// Giữ literal cục bộ thay vì import ShiftLogType: module đó kéo theo hằng múi giờ, còn file này chỉ là số học thuần. Được assert với enum thật trong spec.
const ShiftLogStart = 'START';

/** Mắt xích nào đoạn kết thúc, tức ai chịu trách nhiệm. */
export const CashSegmentKind = {
  /** Ngày giao dịch mở → thu ngân đầu tiên nhận két. Chưa ai giữ két. */
  OPENING: 'OPENING',
  /** Một thu ngân giữ két, từ `START` đến `END` của họ. */
  SHIFT: 'SHIFT',
  /** Giữa lúc một thu ngân trả và người kế tiếp nhận - không ai giữ két. */
  GAP: 'GAP',
  /** `END` cuối → số đếm đóng ca của quản lý. */
  CLOSING: 'CLOSING',
} as const;

export type CashSegmentKind =
  (typeof CashSegmentKind)[keyof typeof CashSegmentKind];

/** Một dòng `CashFlow`, đã lọc còn tiền mặt, chi nhánh này và ngày giao dịch này. */
export interface CashMovement {
  at: Date;
  /** `INCOME` | `EXPENSE` - dấu được áp dụng ở đây, không phải caller. */
  flowType: string;
  amount: number;
}

/** Phần của sổ ca mà phép tính này cần. */
export interface ShiftLogEntry {
  type: string;
  staffId: string;
  amount: number;
  loggedAt: Date;
}

export interface ReconcileInput {
  openingAmount: number;
  /** Số đếm đóng ca của quản lý, hoặc `null` khi session còn mở. */
  finalAmount: number | null;
  /** Theo thứ tự thời gian, như `SESSION_INCLUDE` đã sắp. */
  shiftLogs: readonly ShiftLogEntry[];
  /** Mọi dòng tiền mặt của ngày giao dịch, không theo thứ tự. */
  movements: readonly CashMovement[];
}

export interface CashSegment {
  kind: CashSegmentKind;
  /** Ai đang giữ két. `null` với OPENING, GAP và CLOSING - đó là ý nghĩa của các loại này. */
  staffId: string | null;
  /** `null` = đầu ngày giao dịch (chưa đếm gì trước đó). */
  from: Date | null;
  /** `null` = còn chạy: ca đang mở, hoặc session chưa ai chốt. */
  to: Date | null;
  /** Số đếm mà đoạn này bắt đầu - mắt xích trước của chuỗi. */
  openingCount: number;
  /** Số đếm mà đoạn kết thúc, hoặc `null` khi đoạn chưa được đếm để chốt. */
  closingCount: number | null;
  cashIn: number;
  cashOut: number;
  netCash: number;
  /** `openingCount + netCash` - lẽ ra phải có bao nhiêu trong két tại `to`. */
  expected: number;
  /** `closingCount − expected`. Âm là hụt, dương là thừa. `null` nếu chưa đóng. */
  variance: number | null;
  movementCount: number;
}

export interface Reconciliation {
  openingAmount: number;
  cashIn: number;
  cashOut: number;
  netCash: number;
  /** `openingAmount + netCash` - lẽ ra két phải có gì khi kết thúc ngày. */
  expectedClosing: number;
  countedClosing: number | null;
  variance: number | null;
  movementCount: number;
  segments: CashSegment[];
}

/** Làm tròn đến xu: `CashFlow.amount` là `Decimal(14,2)` đọc qua `Number()`, vài trăm dòng cộng lại có thể ra 1234.9999999999998. */
function money(value: number): number {
  const rounded = Math.round(value * 100) / 100;
  // `-0` là giá trị JS thật mà phép so sánh nghiêm ngặt ở client không coi là 0.
  return rounded === 0 ? 0 : rounded;
}

/** `INCOME` cộng vào két, còn lại thì trừ. */
export function signedAmount(movement: CashMovement): number {
  return movement.flowType === FlowType.INCOME
    ? movement.amount
    : -movement.amount;
}

/** Chia ngày giao dịch thành đoạn tại mỗi số tiền đã đếm và gán từng dòng vào đoạn chứa nó. Dòng đúng tại biên thuộc đoạn sau, để rơi vào thu ngân đang nhận két chứ không phụ thuộc thứ tự sắp xếp. */
export function reconcileSession(input: ReconcileInput): Reconciliation {
  const logs = [...input.shiftLogs].sort(
    (a, b) => a.loggedAt.getTime() - b.loggedAt.getTime(),
  );
  const movements = [...input.movements].sort(
    (a, b) => a.at.getTime() - b.at.getTime(),
  );

  const segments: CashSegment[] = [];
  let cursor = 0; // Đã đi tới đâu trong `movements`; mỗi dòng chỉ dùng đúng một lần
  let openingCount = input.openingAmount;

  for (let i = 0; i <= logs.length; i++) {
    const previous = i === 0 ? null : logs[i - 1];
    const next = i < logs.length ? logs[i] : null;

    let cashIn = 0;
    let cashOut = 0;
    let movementCount = 0;
    while (cursor < movements.length) {
      const movement = movements[cursor];
      // Đoạn cuối không có biên trên: chạy đến hết ngày giao dịch.
      if (next && movement.at.getTime() >= next.loggedAt.getTime()) break;
      if (movement.flowType === FlowType.INCOME) cashIn += movement.amount;
      else cashOut += movement.amount;
      movementCount++;
      cursor++;
    }

    const netCash = cashIn - cashOut;
    const expected = openingCount + netCash;
    const closingCount = next ? next.amount : input.finalAmount;

    segments.push({
      kind: segmentKind(previous, next),
      // Quyền giữ két thuộc người ghi START mở đoạn; sau END không ai giữ két, nên GAP là loại riêng.
      staffId: previous?.type === ShiftLogStart ? previous.staffId : null,
      from: previous ? previous.loggedAt : null,
      to: next ? next.loggedAt : null,
      openingCount: money(openingCount),
      closingCount: closingCount === null ? null : money(closingCount),
      cashIn: money(cashIn),
      cashOut: money(cashOut),
      netCash: money(netCash),
      expected: money(expected),
      variance: closingCount === null ? null : money(closingCount - expected),
      movementCount,
    });

    if (closingCount === null) break;
    openingCount = closingCount;
  }

  const cashIn = movements
    .filter((m) => m.flowType === FlowType.INCOME)
    .reduce((sum, m) => sum + m.amount, 0);
  const cashOut = movements
    .filter((m) => m.flowType !== FlowType.INCOME)
    .reduce((sum, m) => sum + m.amount, 0);
  const netCash = cashIn - cashOut;
  const expectedClosing = input.openingAmount + netCash;

  return {
    openingAmount: money(input.openingAmount),
    cashIn: money(cashIn),
    cashOut: money(cashOut),
    netCash: money(netCash),
    expectedClosing: money(expectedClosing),
    countedClosing:
      input.finalAmount === null ? null : money(input.finalAmount),
    variance:
      input.finalAmount === null
        ? null
        : money(input.finalAmount - expectedClosing),
    movementCount: movements.length,
    segments,
  };
}

/** `next` phân biệt đoạn cuối ngày với khoảng nghỉ thường: cả hai đều theo sau một END, nhưng chỉ đoạn không có gì sau nó mới kết thúc ở số đếm đóng ca của quản lý, nơi chênh lệch đếm lại hiện ra. */
function segmentKind(
  previous: ShiftLogEntry | null,
  next: ShiftLogEntry | null,
): CashSegmentKind {
  if (!previous) return CashSegmentKind.OPENING;
  if (previous.type === ShiftLogStart) return CashSegmentKind.SHIFT;
  return next ? CashSegmentKind.GAP : CashSegmentKind.CLOSING;
}

/** Bản rút gọn cho danh sách session: cùng số tổng từ tổng đã gom sẵn, nên báo cáo 90 ngày là một truy vấn gom nhóm thay vì 90 lần phân bổ từng dòng. */
export function summarizeVariance(input: {
  openingAmount: number;
  finalAmount: number | null;
  cashIn: number;
  cashOut: number;
}): {
  openingAmount: number;
  cashIn: number;
  cashOut: number;
  netCash: number;
  expectedClosing: number;
  countedClosing: number | null;
  variance: number | null;
} {
  const netCash = input.cashIn - input.cashOut;
  const expectedClosing = input.openingAmount + netCash;
  return {
    openingAmount: money(input.openingAmount),
    cashIn: money(input.cashIn),
    cashOut: money(input.cashOut),
    netCash: money(netCash),
    expectedClosing: money(expectedClosing),
    countedClosing:
      input.finalAmount === null ? null : money(input.finalAmount),
    variance:
      input.finalAmount === null
        ? null
        : money(input.finalAmount - expectedClosing),
  };
}
