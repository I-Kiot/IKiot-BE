import type { AttendanceLocationColumns } from '../../common/dto/attendance-location.dto';
import type { AttendanceLocationRow } from '../../common/dto/attendance-location.dto';
import type { QuotaField } from '../subscriptions/subscriptions.service';
import type { Prisma } from '../../../generated/prisma/client';

/** The manager summary every location embeds; Branch and Warehouse each carried their own identical copy of this select. */
export const MANAGER_SELECT = {
  id: true,
  phoneNumber: true,
  email: true,
  profileFirstName: true,
  profileLastName: true,
  profileAvatarUrl: true,
} as const;

export const LOCATION_INCLUDE = {
  manager: { select: MANAGER_SELECT },
} as const;

export interface LocationManager {
  id: string;
  phoneNumber: string;
  email: string | null;
  profileFirstName: string | null;
  profileLastName: string | null;
  profileAvatarUrl: string | null;
}

/** The columns LocationService reads on any location row it is handed. */
export interface LocationRow extends AttendanceLocationRow {
  id: string;
  tenantId: string;
  name: string;
  status: string;
  managerId: string | null;
  manager: LocationManager | null;
  createdAt: Date;
}

export interface LocationWhere {
  id?: string;
  tenantId?: string;
  status?: string | { not: string };
  name?: { contains: string; mode: 'insensitive' };
}

export interface LocationCreateData extends AttendanceLocationColumns {
  tenantId: string;
  name: string;
  phoneNumber: string[];
  address?: string;
  email?: string;
}

export interface LocationUpdateData extends AttendanceLocationColumns {
  name?: string;
  phoneNumber?: string[];
  address?: string;
  email?: string;
  status?: string;
  managerId?: string | null;
}

/** The five queries LocationService runs, as a structural type both Prisma delegates satisfy as-is - so one service body drives two models without casts. `include` is required wherever a row comes back, and the results are `PrismaPromise` so they can go into `$transaction([...])`. */
export interface LocationDelegate<TRow extends LocationRow> {
  findMany(args: {
    where: LocationWhere;
    include: typeof LOCATION_INCLUDE;
    orderBy: { createdAt: 'desc' };
    skip?: number;
    take?: number;
  }): Prisma.PrismaPromise<TRow[]>;
  count(args: { where: LocationWhere }): Prisma.PrismaPromise<number>;
  findFirst(args: {
    where: LocationWhere;
    include: typeof LOCATION_INCLUDE;
  }): Prisma.PrismaPromise<TRow | null>;
  create(args: {
    data: LocationCreateData;
    include: typeof LOCATION_INCLUDE;
  }): Prisma.PrismaPromise<TRow>;
  update(args: {
    where: { id: string };
    data: LocationUpdateData;
    include: typeof LOCATION_INCLUDE;
  }): Prisma.PrismaPromise<TRow>;
}

/** Every message that differs between a branch and a warehouse, in one place. */
export interface LocationMessages {
  notFound: string;
  alreadyDeleted: string;
  /** The noun in "đã đạt giới hạn <...> của gói dịch vụ". */
  quotaLabel: string;
  staffStillAttached: (count: number) => string;
  staffNotEligible: string;
  staffPostedElsewhere: string;
}

export interface LocationConfig {
  /** Which plan quota caps how many of these a tenant may open. */
  quotaField: QuotaField;
  /** The User column that posts someone at this kind of location… */
  postingField: 'branchId' | 'warehouseId';
  /** …and the other one, which has to be empty before they can be appointed here. */
  otherPostingField: 'branchId' | 'warehouseId';
  messages: LocationMessages;
}
