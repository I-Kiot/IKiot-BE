import { ForbiddenException } from '@nestjs/common';
import { ErrorCode } from '../errors/error-codes';

/** Filter của client chỉ được thu hẹp scope do server tính, không được thay thế - `?branchId=` từng ghi đè scope và đưa thu ngân xem sổ của chi nhánh khác. */
export function narrowToScope(
  scoped: string | undefined,
  requested: string | undefined,
  message: string,
): string | undefined {
  if (!requested) return scoped;
  // Gửi lại đúng scope của mình là bình thường - màn hình thường echo lại những gì nó đang hiển thị.
  if (scoped !== undefined && requested !== scoped) {
    throw new ForbiddenException({
      code: ErrorCode.SCOPE_FILTER_DENIED,
      message,
    });
  }
  return requested;
}

/** Được đọc dòng nhân sự của ai: luôn là của chính mình, được mở rộng tới địa điểm đã gán khi có quyền read-all. Object rỗng nghĩa là không giới hạn. */
export interface StaffReadScope {
  userId?: string;
  branchId?: string;
  warehouseId?: string;
}

/** Các bộ lọc `?userId=` / `?branchId=` / `?warehouseId=` mà endpoint danh sách chấp nhận. */
export interface StaffScopeQuery {
  userId?: string;
  branchId?: string;
  warehouseId?: string;
}

/** Áp {@link narrowToScope} cho cả ba filter nhân sự cùng lúc - ghép tay từng cái là thứ để `?branchId=` thay thế chi nhánh do server suy ra. */
export function narrowStaffScope(
  scope: StaffReadScope,
  query: StaffScopeQuery,
  messages: { own: string; location: string },
): StaffReadScope {
  return {
    userId: narrowToScope(scope.userId, query.userId, messages.own),
    branchId: narrowToScope(scope.branchId, query.branchId, messages.location),
    warehouseId: narrowToScope(
      scope.warehouseId,
      query.warehouseId,
      messages.location,
    ),
  };
}
