import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SystemRole } from '../../common/constants/system-role';
import { UserStatus } from '../../common/constants/user-status';
import { ScheduleStatus } from './working-schedule.constants';
import type { ShiftSupervisorAccess } from '../../common/types/auth-user.type';
import {
  LOCATION_TYPE_SELECT,
  columnsOfLocation,
} from '../../common/dto/location-ref.dto';

/**
 * Quyền tạm của STAFF chỉ có khi ca họ đang quản lý đang chạy (`managedScheduleAccess` của iKiotMS-BE): người được `managedBy` trên lịch đang chạy được mở két, nhận hàng, thanh toán nhà cung cấp tại địa điểm của mình mà không cần quyền cố định.
 * Ba ràng buộc giữ phạm vi hẹp: chỉ ca SCHEDULED đang bao trùm thời điểm hiện tại; chỉ bộ `TEMPORARY_PERMISSIONS`; chỉ địa điểm vừa thuộc ca vừa thuộc posting của người giám sát. `suppliers` là ngoại lệ của ràng buộc cuối vì NCC là dữ liệu toàn tenant.
 */

/** Đúng bằng `TEMPORARY_PERMISSIONS` cũ. Nới rộng danh sách này là nới rộng những gì một ca được cấp. */
export const TEMPORARY_PERMISSIONS: Readonly<
  Record<string, readonly string[]>
> = Object.freeze({
  cash_drawers: Object.freeze(['open', 'read', 'read_own', 'finalize']),
  suppliers: Object.freeze(['read', 'update', 'delete']),
  stock_movement: Object.freeze([
    'create',
    'read',
    'update',
    'approve',
    'receive',
    'cancel',
  ]),
});

const TEMPORARY_KEYS: ReadonlySet<string> = new Set(
  Object.entries(TEMPORARY_PERMISSIONS).flatMap(([resource, actions]) =>
    actions.map((action) => `${resource}:${action}`),
  ),
);

@Injectable()
export class ShiftSupervisorService {
  constructor(private readonly prisma: PrismaService) {}

  static grants(resource: string, action: string): boolean {
    return TEMPORARY_KEYS.has(`${resource}:${action}`);
  }

  /** Gọi từ `JwtStrategy` ở mọi request nên chỉ tốn một query, dùng posting mà `JwtStrategy` đã có sẵn. */
  async resolve(
    user: {
      userId: string;
      tenantId: string | null;
      systemRole: string;
      branchId: string | null;
      warehouseId: string | null;
      status: string;
    },
    now = new Date(),
  ): Promise<ShiftSupervisorAccess | null> {
    if (user.systemRole !== SystemRole.STAFF) return null;
    if (!user.tenantId || user.status !== UserStatus.ACTIVE) return null;

    const schedules = await this.prisma.workingSchedule.findMany({
      where: {
        tenantId: user.tenantId,
        managedById: user.userId,
        status: ScheduleStatus.SCHEDULED,
        startAt: { lte: now },
        endAt: { gt: now },
      },
      select: {
        id: true,
        startAt: true,
        endAt: true,
        assignedUsers: {
          select: { user: { select: { location: LOCATION_TYPE_SELECT } } },
        },
      },
    });
    if (schedules.length === 0) return null;

    // Nơi những người trong ca làm việc…
    const branchIds = new Set<string>();
    const warehouseIds = new Set<string>();
    for (const schedule of schedules) {
      for (const { user: member } of schedule.assignedUsers) {
        const posting = columnsOfLocation(member.location);
        if (posting.branchId) branchIds.add(posting.branchId);
        if (posting.warehouseId) warehouseIds.add(posting.warehouseId);
      }
    }

    // …giao với nơi chính người giám sát làm việc: ca có người từ chi nhánh khác không được với tới chi nhánh đó.
    for (const branchId of branchIds) {
      if (branchId !== user.branchId) branchIds.delete(branchId);
    }
    for (const warehouseId of warehouseIds) {
      if (warehouseId !== user.warehouseId) warehouseIds.delete(warehouseId);
    }
    if (branchIds.size === 0 && warehouseIds.size === 0) return null;

    const starts = schedules.map((s) => s.startAt?.getTime() ?? 0);
    const ends = schedules.map((s) => s.endAt?.getTime() ?? 0);

    return {
      scheduleIds: schedules.map((schedule) => schedule.id),
      branchIds: [...branchIds],
      warehouseIds: [...warehouseIds],
      startsAt: new Date(Math.min(...starts)),
      endsAt: new Date(Math.max(...ends)),
    };
  }

  static keysFor(access: ShiftSupervisorAccess | null): string[] {
    if (!access) return [];
    return [
      ...(access.branchIds.length > 0 || access.warehouseIds.length > 0
        ? TEMPORARY_KEYS
        : []),
    ];
  }
}

/** Điểm duy nhất để `StockMovementService.canActAt()` và `CashDrawerSessionService.resolveBranch()` nới quyền theo ca đang chạy. */
export function supervisesLocation(
  access: ShiftSupervisorAccess | null | undefined,
  location: { branchId: string | null; warehouseId: string | null },
): boolean {
  if (!access) return false;
  if (location.branchId) return access.branchIds.includes(location.branchId);
  if (location.warehouseId) {
    return access.warehouseIds.includes(location.warehouseId);
  }
  return false;
}
