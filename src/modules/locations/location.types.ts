import type { QuotaField } from '../subscriptions/subscriptions.service';
import type { LocationType } from '../../common/constants/location-type';
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

/** A Location row as LocationService reads and returns it. Branch/Warehouse rows carry no columns of their own beyond the link, so everything the API shows lives here. */
export type LocationRow = Prisma.LocationGetPayload<{
  include: typeof LOCATION_INCLUDE;
}>;

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
  /** `Location.type` this service owns - every query is narrowed to it. */
  kind: LocationType;
  /** Which 1:1 specialization row is created alongside the Location. */
  specialization: 'branch' | 'warehouse';
  /** Which plan quota caps how many of these a tenant may open. */
  quotaField: QuotaField;
  messages: LocationMessages;
}
