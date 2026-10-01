import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SystemRole } from '../../common/constants/system-role';
import { UserStatus } from '../../common/constants/user-status';
import { ScheduleStatus } from './working-schedule.constants';
import type { ShiftSupervisorAccess } from '../../common/types/auth-user.type';

/** The extra permissions a STAFF account holds only while the shift they are running is actually running (iKiotMS-BE's `managedScheduleAccess`): whoever is `managedBy` on a live schedule can open the till, receive stock and settle supplier paperwork at their own location without a permanent grant. Three things keep it narrow - only SCHEDULED shifts whose window contains now, only the fixed `TEMPORARY_PERMISSIONS` set, and only locations on both the shift and the supervisor's own posting. `suppliers` is the exception to the last, since supplier records are tenant-wide. */

/** Exactly the old `TEMPORARY_PERMISSIONS`. Widening this widens what a shift can grant. */
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

/** Every `"<resource>:<action>"` a live shift can add. */
const TEMPORARY_KEYS: ReadonlySet<string> = new Set(
  Object.entries(TEMPORARY_PERMISSIONS).flatMap(([resource, actions]) =>
    actions.map((action) => `${resource}:${action}`),
  ),
);

@Injectable()
export class ShiftSupervisorService {
  constructor(private readonly prisma: PrismaService) {}

  /** Whether a pair is one a shift could ever grant - cheap pre-check before querying. */
  static grants(resource: string, action: string): boolean {
    return TEMPORARY_KEYS.has(`${resource}:${action}`);
  }

  /** Resolves the caller's live supervision, or `null`. Called from `JwtStrategy` on every request, so it is one query plus the posting `JwtStrategy` already has and passes in. */
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
          select: { user: { select: { branchId: true, warehouseId: true } } },
        },
      },
    });
    if (schedules.length === 0) return null;

    // Where the shift's people work…
    const branchIds = new Set<string>();
    const warehouseIds = new Set<string>();
    for (const schedule of schedules) {
      for (const { user: member } of schedule.assignedUsers) {
        if (member.branchId) branchIds.add(member.branchId);
        if (member.warehouseId) warehouseIds.add(member.warehouseId);
      }
    }

    // …intersected with where the supervisor themselves works: supervising a shift that includes somebody from another branch must not reach into that branch.
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

  /** The permission keys a resolved supervision contributes. */
  static keysFor(access: ShiftSupervisorAccess | null): string[] {
    if (!access) return [];
    return [
      ...(access.branchIds.length > 0 || access.warehouseIds.length > 0
        ? TEMPORARY_KEYS
        : []),
    ];
  }
}

/** May this account act at this location because of a shift it is running right now? The one seam `StockMovementService.canActAt()` and `CashDrawerSessionService.resolveBranch()` widen through. */
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
