import { SetMetadata } from '@nestjs/common';

export const PERMISSIONS_KEY = 'permissions';

export interface RequiredPermission {
  resource: string;
  /** Chỉ cần một trong các action là đủ. */
  actions: string[];
}

/** Khai báo route cần quyền gì (ADMIN và TENANT_OWNER luôn qua). Nhiều action nghĩa là "một trong số đó", như `authorize(module, [a, b])` của iKiotMS-BE. */
export const Permissions = (resource: string, ...actions: string[]) =>
  SetMetadata(PERMISSIONS_KEY, {
    resource,
    actions,
  } satisfies RequiredPermission);
