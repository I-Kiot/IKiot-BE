import { ForbiddenException } from '@nestjs/common';
import { ErrorCode } from '../errors/error-codes';

/** A client filter may narrow a server-derived scope, never replace it - `?branchId=` used to overwrite it and hand a cashier another branch's ledger. */
export function narrowToScope(
  scoped: string | undefined,
  requested: string | undefined,
  message: string,
): string | undefined {
  if (!requested) return scoped;
  // Passing back your own scope is normal - a screen echoes whatever it was showing.
  if (scoped !== undefined && requested !== scoped) {
    throw new ForbiddenException({
      code: ErrorCode.SCOPE_FILTER_DENIED,
      message,
    });
  }
  return requested;
}

/** Where an account may read other people's HR rows from: always your own, widened to your posted location by a read-all permission. An empty object means no restriction. */
export interface StaffReadScope {
  userId?: string;
  branchId?: string;
  warehouseId?: string;
}

/** The `?userId=` / `?branchId=` / `?warehouseId=` filters a list endpoint accepts. */
export interface StaffScopeQuery {
  userId?: string;
  branchId?: string;
  warehouseId?: string;
}

/** Applies {@link narrowToScope} to all three staff filters at once - merging them by hand is what let `?branchId=` replace the server-derived branch. */
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
