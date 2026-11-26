import type { Prisma } from '../../../generated/prisma/client';
import {
  BRANCH_NAME_SELECT,
  LOCATION_SELECT,
} from '../../common/dto/location-ref.dto';
import { PaymentKind } from './order-read.constants';

// Include cho đọc đơn; giữ mọi trường POS đang dùng.

export const USER_REF_SELECT = {
  select: {
    id: true,
    phoneNumber: true,
    profileFirstName: true,
    profileLastName: true,
  },
} as const satisfies Prisma.UserDefaultArgs;

/** Khoản shipper thu khi giao, lấy dòng mới nhất. */
const BALANCE_PAYMENT_INCLUDE = {
  where: { kind: PaymentKind.BALANCE },
  orderBy: { createdAt: 'desc' },
  take: 1,
  include: {
    collectedBy: USER_REF_SELECT,
    remittanceConfirmedBy: USER_REF_SELECT,
  },
} as const satisfies Prisma.Order$paymentsArgs;

/** SKU của dòng đơn, kèm cờ sản xuất được. */
const LINE_PRODUCT_ITEM_SELECT = {
  select: {
    id: true,
    sku: true,
    productName: true,
    product: { select: { isManufacturable: true } },
  },
} as const satisfies Prisma.ProductItemDefaultArgs;

/** Một dòng danh sách đơn kèm các dòng hàng. */
export const ORDER_LIST_INCLUDE = {
  customer: { select: { id: true, name: true, phone: true } },
  branch: BRANCH_NAME_SELECT,
  user: USER_REF_SELECT,
  assignee: USER_REF_SELECT,
  seller: USER_REF_SELECT,
  confirmedBy: USER_REF_SELECT,
  shippedBy: USER_REF_SELECT,
  items: {
    include: { productItem: LINE_PRODUCT_ITEM_SELECT },
  },
  appliedPromotions: true,
  payments: BALANCE_PAYMENT_INCLUDE,
  shipments: {
    orderBy: { createdAt: 'desc' },
    take: 1,
    select: {
      id: true,
      status: true,
      carrierType: true,
      driver: USER_REF_SELECT,
    },
  },
} as const satisfies Prisma.OrderInclude;

export const ORDER_DETAIL_INCLUDE = {
  ...ORDER_LIST_INCLUDE,
  items: {
    include: {
      productItem: LINE_PRODUCT_ITEM_SELECT,
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
