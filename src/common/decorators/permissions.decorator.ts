import { SetMetadata } from '@nestjs/common';

export const PERMISSIONS_KEY = 'permissions';

export interface RequiredPermission {
  resource: string;
  /** Chỉ cần một trong các action là đủ. */
  actions: string[];
}

/** Khai báo quyền route cần; nhiều action thì có một là đủ. */
export const Permissions = (resource: string, ...actions: string[]) =>
  SetMetadata(PERMISSIONS_KEY, {
    resource,
    actions,
  } satisfies RequiredPermission);
