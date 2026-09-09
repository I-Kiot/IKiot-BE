import { SetMetadata } from '@nestjs/common';

export const PERMISSIONS_KEY = 'permissions';

export interface RequiredPermission {
  resource: string;
  /** Any one of these is enough - see the decorator's note. */
  actions: string[];
}

/** Declares what a route requires (ADMIN and TENANT_OWNER always pass). Several actions mean "any of them", as iKiotMS-BE's `authorize(module, [a, b])` did. */
export const Permissions = (resource: string, ...actions: string[]) =>
  SetMetadata(PERMISSIONS_KEY, {
    resource,
    actions,
  } satisfies RequiredPermission);
