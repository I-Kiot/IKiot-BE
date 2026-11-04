import type { QuotaField } from '../subscriptions/subscriptions.service';
import type { LocationType } from '../../common/constants/location-type';
import type { Prisma } from '../../../generated/prisma/client';

/** Tóm tắt quản lý mà mọi địa điểm nhúng; trước đây chi nhánh và kho mỗi bên có một bản y hệt. */
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

/** Dòng Location như LocationService đọc và trả về. Chi nhánh / kho không có cột riêng ngoài liên kết, nên mọi thứ API hiện đều nằm ở đây. */
export type LocationRow = Prisma.LocationGetPayload<{
  include: typeof LOCATION_INCLUDE;
}>;

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
  /** `Location.type` mà service này quản lý; mọi truy vấn đều lọc theo nó. */
  kind: LocationType;
  specialization: 'branch' | 'warehouse';
  quotaField: QuotaField;
  messages: LocationMessages;
}
