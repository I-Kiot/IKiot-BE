import { CashSegmentKind, type CashSegment } from './cash-reconciliation';

/**
 * Gộp các đoạn đối soát của nhiều phiên theo thu ngân (2026-11-27), cho bảng "Theo thu ngân" của Lịch sử két.
 *
 * Chỉ đoạn SHIFT có người chịu trách nhiệm: từ lúc một người ghi START tới lần đếm kế tiếp. Lệch ở các đoạn còn lại
 * không gán cho ai và được cộng riêng: OPENING (mở két → người đầu nhận), GAP (giữa lúc trả và lúc người sau nhận),
 * CLOSING (lần trả cuối → quản lý đếm chốt). Đặt chung vào một người sẽ đổ cho họ khoản lệch họ không giữ.
 *
 * Đầu vào là đúng các đoạn `reconcileSession` trả cho từng phiên, nên tổng ở đây khớp từng đồng với bảng theo ca.
 */

export interface CashierSummaryRow {
  staffId: string;
  /** Số ca (đoạn SHIFT) người này giữ két. */
  shifts: number;
  /** Số phiên (ngày × chi nhánh) có ít nhất một ca của người này. */
  sessions: number;
  /** Ca chưa đếm xong (còn giữ két) không có chênh lệch. */
  openShifts: number;
  cashIn: number;
  cashOut: number;
  /** Tổng chênh lệch các ca đã đếm: âm là thiếu. */
  variance: number;
  shortShifts: number;
  /** Âm. */
  shortfall: number;
  overShifts: number;
  overage: number;
}

export interface UnattributedVariance {
  kind: Exclude<CashSegmentKind, 'SHIFT'>;
  /** Số đoạn có chênh lệch khác 0. */
  count: number;
  variance: number;
}

export interface CashierSummary {
  rows: CashierSummaryRow[];
  unattributed: UnattributedVariance[];
}

const round = (n: number) => {
  const r = Math.round(n * 100) / 100;
  return r === 0 ? 0 : r;
};

export function summarizeByCashier(
  sessions: { sessionId: string; segments: readonly CashSegment[] }[],
): CashierSummary {
  const byStaff = new Map<
    string,
    Omit<CashierSummaryRow, 'sessions'> & { sessionIds: Set<string> }
  >();
  const unattributed = new Map<
    UnattributedVariance['kind'],
    UnattributedVariance
  >();

  for (const { sessionId, segments } of sessions) {
    for (const segment of segments) {
      const { kind } = segment;
      if (kind !== CashSegmentKind.SHIFT) {
        if (segment.variance === null || segment.variance === 0) continue;
        const entry = unattributed.get(kind) ?? { kind, count: 0, variance: 0 };
        entry.count++;
        entry.variance += segment.variance;
        unattributed.set(kind, entry);
        continue;
      }
      // Đoạn SHIFT luôn mở bằng START của một người; thiếu thì là dữ liệu hỏng, bỏ qua.
      if (!segment.staffId) continue;

      const row = byStaff.get(segment.staffId) ?? {
        staffId: segment.staffId,
        shifts: 0,
        openShifts: 0,
        cashIn: 0,
        cashOut: 0,
        variance: 0,
        shortShifts: 0,
        shortfall: 0,
        overShifts: 0,
        overage: 0,
        sessionIds: new Set<string>(),
      };
      row.shifts++;
      row.sessionIds.add(sessionId);
      row.cashIn += segment.cashIn;
      row.cashOut += segment.cashOut;
      if (segment.variance === null) {
        row.openShifts++;
      } else if (segment.variance < 0) {
        row.shortShifts++;
        row.shortfall += segment.variance;
        row.variance += segment.variance;
      } else if (segment.variance > 0) {
        row.overShifts++;
        row.overage += segment.variance;
        row.variance += segment.variance;
      }
      byStaff.set(segment.staffId, row);
    }
  }

  const rows = [...byStaff.values()]
    .map(({ sessionIds, ...row }) => ({
      ...row,
      sessions: sessionIds.size,
      cashIn: round(row.cashIn),
      cashOut: round(row.cashOut),
      variance: round(row.variance),
      shortfall: round(row.shortfall),
      overage: round(row.overage),
    }))
    // Người thiếu nhiều nhất lên đầu, rồi người giữ két nhiều ca nhất.
    .sort((a, b) => a.shortfall - b.shortfall || b.shifts - a.shifts);

  const order: UnattributedVariance['kind'][] = [
    CashSegmentKind.OPENING,
    CashSegmentKind.GAP,
    CashSegmentKind.CLOSING,
  ];
  return {
    rows,
    unattributed: order
      .map((kind) => unattributed.get(kind))
      .filter((entry): entry is UnattributedVariance => entry !== undefined)
      .map((entry) => ({ ...entry, variance: round(entry.variance) })),
  };
}
