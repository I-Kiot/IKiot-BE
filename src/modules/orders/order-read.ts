import type { Prisma } from '../../../generated/prisma/client';
import {
  BRANCH_NAME_SELECT,
  LOCATION_SELECT,
} from '../../common/dto/location-ref.dto';
import { PaymentKind } from './order-read.constants';

// Dữ liệu `GET /orders` và `GET /orders/:id` đọc (A-9, contract §2). Cả hai là tập cha của include của quầy trong orders.service.ts:
// POS vẫn liệt kê và mở đơn qua hai route này, đọc `items`, `user`, `appliedPromotions` từ đó, nên không được bỏ bất cứ thứ gì nó đang nhận;
// các trường hành trình được thêm bên cạnh.

export const USER_REF_SELECT = {
  select: {
    id: true,
    phoneNumber: true,
    profileFirstName: true,
    profileLastName: true,
  },
} as const satisfies Prisma.UserDefaultArgs;

/** Số tiền shipper thu khi giao và đã về tay chủ chưa, `collection` được dựng từ đây. Mỗi đơn tối đa một dòng; nếu lần thất bại trước để lại dòng cũ thì lấy dòng mới nhất. */
const BALANCE_PAYMENT_INCLUDE = {
  where: { kind: PaymentKind.BALANCE },
  orderBy: { createdAt: 'desc' },
  take: 1,
  include: {
    collectedBy: USER_REF_SELECT,
    remittanceConfirmedBy: USER_REF_SELECT,
  },
} as const satisfies Prisma.Order$paymentsArgs;

/** Một dòng danh sách đơn. Giữ mọi dòng hàng: danh sách hóa đơn của POS mở rộng chúng tại chỗ, và `stockSummary` là `stockCheck` của dòng tệ nhất nên vẫn cần các dòng. */
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
