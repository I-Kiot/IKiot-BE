import { businessDate } from './business-date';
import { CashDrawerStatus } from './cash-drawer.constants';

/**
 * Khoảng thời gian mà đối soát cộng dòng tiền vào một phiên: từ lúc mở (`createdAt`) tới lúc chốt (`closedAt`), hoặc
 * tới `now` khi còn mở. Half-open, `[start, end)`.
 *
 * Trước đây là ngày giao dịch (`businessDayRange(businessDate)`), và điều đó sai đúng ở trường hợp cần nó nhất: két
 * quên chốt, chốt muộn hôm sau. Số đếm khi chốt đã gồm tiền của hôm sau, còn tiền đó không nằm trong ngày giao dịch,
 * nên phiên báo thừa đúng bằng tiền mặt thuần hôm sau, và hôm sau không có phiên nào để báo. Theo khoảng của phiên,
 * chốt muộn chỉ là một phiên dài. Hai phiên của một chi nhánh không bao giờ chồng nhau (tối đa một phiên OPEN), nên
 * mỗi dòng tiền thuộc nhiều nhất một phiên.
 *
 * Hệ quả cố ý: tiền mặt thu trước lúc mở két, hoặc giữa lúc chốt và lần mở kế tiếp, không thuộc két nào - lúc đó
 * không có két để tiền nằm vào.
 */
export function sessionWindow(
  session: { createdAt: Date; closedAt: Date | null },
  now: Date = new Date(),
): { start: Date; end: Date } {
  return { start: session.createdAt, end: session.closedAt ?? now };
}

/**
 * Két quá hạn: còn mở nhưng thuộc một ngày giao dịch đã qua - có người quên chốt. Một bản duy nhất của quy tắc: cờ
 * `overdue` trên response, việc chặn bàn giao, `GET /cash-drawer-sessions/overdue` và cron nhắc buổi sáng đều gọi hàm
 * này, không ai viết lại điều kiện thành `where`.
 */
export function isOverdue(
  session: { status: string; businessDate: Date },
  now: Date = new Date(),
): boolean {
  return (
    session.status === CashDrawerStatus.OPEN &&
    session.businessDate.getTime() < businessDate(now).getTime()
  );
}
