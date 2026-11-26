import { businessDate } from './business-date';
import { CashDrawerStatus } from './cash-drawer.constants';

/** Khoảng thời gian của phiên: từ lúc mở tới lúc chốt (hoặc tới bây giờ). */
export function sessionWindow(
  session: { createdAt: Date; closedAt: Date | null },
  now: Date = new Date(),
): { start: Date; end: Date } {
  return { start: session.createdAt, end: session.closedAt ?? now };
}

/** Két quá hạn: còn mở nhưng thuộc ngày đã qua. */
export function isOverdue(
  session: { status: string; businessDate: Date },
  now: Date = new Date(),
): boolean {
  return (
    session.status === CashDrawerStatus.OPEN &&
    session.businessDate.getTime() < businessDate(now).getTime()
  );
}
