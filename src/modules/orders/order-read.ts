import type { Prisma } from '../../../generated/prisma/client';
import {
  BRANCH_NAME_SELECT,
  LOCATION_SELECT,
} from '../../common/dto/location-ref.dto';
import { PaymentKind } from './order-read.constants';

// What `GET /orders` and `GET /orders/:id` read (A-9, contract §2). Both are supersets of the
// till's own include in orders.service.ts: POS still lists and opens orders through these two
// routes and reads `items`, `user` and `appliedPromotions` off them, so nothing it gets today may
// disappear - the order-journey fields are added beside it.

/** The `UserRef` of the contract - `{ id, name, phoneNumber }` once mapped; `name` is put together from the profile columns. */
export const USER_REF_SELECT = {
  select: {
    id: true,
    phoneNumber: true,
    profileFirstName: true,
    profileLastName: true,
  },
} as const satisfies Prisma.UserDefaultArgs;

/** The money the shipper collected on delivery, and whether it reached the owner - what `collection` is built from. One per order at most; the newest wins if a failed attempt left an older one. */
const BALANCE_PAYMENT_INCLUDE = {
  where: { kind: PaymentKind.BALANCE },
  orderBy: { createdAt: 'desc' },
  take: 1,
  include: {
    collectedBy: USER_REF_SELECT,
    remittanceConfirmedBy: USER_REF_SELECT,
  },
} as const satisfies Prisma.Order$paymentsArgs;

/** One row of the order list. Keeps every line: POS's invoice list expands them in place, and `stockSummary` is the worst line's `stockCheck`, so the lines are needed either way. */
export const ORDER_LIST_INCLUDE = {
  customer: { select: { id: true, name: true, phone: true } },
  branch: BRANCH_NAME_SELECT,
  user: USER_REF_SELECT,
  assignee: USER_REF_SELECT,
  confirmedBy: USER_REF_SELECT,
  shippedBy: USER_REF_SELECT,
  items: {
    include: {
      productItem: { select: { id: true, sku: true, productName: true } },
    },
  },
  appliedPromotions: true,
  payments: BALANCE_PAYMENT_INCLUDE,
} as const satisfies Prisma.OrderInclude;

/** One order opened in full: the list row plus each line's customization and source location, its shipments and its returns. */
export const ORDER_DETAIL_INCLUDE = {
  ...ORDER_LIST_INCLUDE,
  items: {
    include: {
      productItem: { select: { id: true, sku: true, productName: true } },
      sourceLocation: LOCATION_SELECT,
      customization: {
        include: { specs: { orderBy: { position: 'asc' } } },
      },
    },
  },
  shipments: {
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      status: true,
      carrierType: true,
      carrierName: true,
      trackingCode: true,
      driver: USER_REF_SELECT,
    },
  },
  returns: {
    orderBy: { createdAt: 'asc' },
    select: { id: true, code: true, status: true },
  },
} as const satisfies Prisma.OrderInclude;

export type OrderListRow = Prisma.OrderGetPayload<{
  include: typeof ORDER_LIST_INCLUDE;
}>;

export type OrderDetailRow = Prisma.OrderGetPayload<{
  include: typeof ORDER_DETAIL_INCLUDE;
}>;
