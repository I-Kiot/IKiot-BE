import { ForbiddenException } from '@nestjs/common';
import { ErrorCode } from '../errors/error-codes';

/** Filter của client chỉ được thu hẹp phạm vi do server tính. */
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

/** Phạm vi đọc dữ liệu nhân sự: của mình, hoặc nơi được gán khi có quyền xem tất cả. */
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

/** Áp `narrowToScope` cho cả ba filter nhân sự. */
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
