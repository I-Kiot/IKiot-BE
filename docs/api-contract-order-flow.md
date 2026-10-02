# Contract API – Hành trình đơn hàng (Phase 1)

> Chốt ở Phase 0 (P0-6, 2026-10-02). Mọi track code theo file này; FE dùng `src/types/*` +
> `src/lib/api/*` đã viết sẵn đúng theo đây. Cần đổi contract → nhắn Astersa, **không tự sửa
> route/field của track khác**. Luồng nghiệp vụ: [`order-flow.md`](../../docs/order-flow.md)
> (workspace) · Task: Notion "Task – Hành trình đơn hàng".

## 0. Quy ước chung

| | |
|---|---|
| Envelope thành công | `{ success: true, message, data }`; list: `{ success, data: T[], pagination: { page, limit, total, totalPages } }` |
| Lỗi | `{ success: false, statusCode, code, message, errors? }` – client **chỉ rẽ nhánh theo `code`** (`src/common/errors/error-codes.ts`, append-only) |
| Id | `id` (uuid). Không bao giờ `_id`. |
| Phân trang / tìm kiếm | `page`, `limit`, `search` |
| Tiền | `number` (VND, Decimal ở DB, serialize ra number) |
| Thời gian | ISO string, `Timestamptz`; ngày thuần (`requestedDeliveryDate`, `expectedReadyDate`, `dueDate`, `scheduledDate`) là `YYYY-MM-DD` |
| Danh tính | `tenantId`, người thao tác **luôn lấy từ token**, không bao giờ nhận từ body |
| Trạng thái | Chỉ dùng hằng trong `src/common/constants/*-status.ts`, `inventory-ledger.ts` – không viết chuỗi tay |
| Cross-tenant | 404, không 403 |
| Quyền | Mỗi route ghi `@Permissions(resource, action)` như bảng dưới + `@ApiBearerAuth('bearer')`. Các cặp đã có sẵn trong seed. |

**Location:** `Branch.id = Warehouse.id = Location.id`. Mọi field `locationId` / `sourceLocationId` /
`damagedLocationId` là id của Location (chi nhánh hay kho đều được, trừ chỗ ghi rõ).

## 1. Hàm dùng chung (chỉ gọi, không sửa) – `InventoryService`

Tất cả nhận `tx` (Prisma transaction client) của caller. Giữ 2 bất biến: Σ `lot.remainingQuantity` = `inventories.stock`;
`inventories.reserved` = Σ `StockReservation` ACTIVE.

| Hàm | Dùng ở | Ghi chú |
|---|---|---|
| `reserve(tx, { tenantId, locationId, productItemId, orderItemId, quantity, allowPartial?, label? })` → `{ held, reservationId }` | A-3, A-4, E-2 | `allowPartial: true` giữ phần đang có; không thì thiếu là `INSUFFICIENT_AVAILABLE_STOCK`. Kho hỏng → `LOCATION_NOT_SELLABLE`. |
| `release(tx, { tenantId, orderItemId, locationId? })` → số đã nhả | A-4, A-5, E-3 | **Gọi trước khi đổi `productItemId` của dòng** (dòng custom). |
| `consume(tx, { tenantId, orderItemId, locationId, quantity, label?, ledger: { referenceType, referenceId, createdById?, note? } })` | C-1 | Đóng hàng: hold → CONSUMED, trừ `stock` + `reserved`, rút lô (FIFO), ghi SALE, cập nhật `OrderItem.unitCostPrice`. Gọi được nhiều lần theo từng phần. `referenceType: FULFILLMENT`. |
| `returnDrawn(tx, { tenantId, productItemId, toLocationId, quantity, drawnBy, ledger, ifNeverDrawn? })` | A-7, D-5 | Hàng quay lại đúng lô đã rút. `drawnBy: { orderItemId }` cho hàng bán. A-7: `type: SALE_REVERSAL`, cùng kho xuất. D-5: `RETURN_GOOD` (kho bán) / `RETURN_DAMAGED` (kho hỏng `damagedLocationId`). |
| `openLot(tx, { tenantId, locationId, productItemId, quantity, unitCost?, sourceType, supplierId?, importItemId?, productionRequestItemId?, orderItemId?, receivedAt?, ledger })` → `{ inventory, lotId }` | B-5 | Hàng mới về (nhập NCC / xưởng). Hàng lỗi của phiếu nhập: `openLot` tại `defectLocationId` với `ledger.type = DEFECT`. |
| `deductStock(tx, { tenantId, locationId, productItemId, quantity, label, ledger })` | (chuyển kho, kiểm kê) | Chỉ lấy hàng **chưa giữ** (`stock − reserved`). Không dùng cho đóng hàng. |
| `allocateArrivals(tx, { tenantId, locationId, productItemId, priorityOrderItemIds? })` → `[{ orderItemId, orderId, quantity, complete }]` | B-5 → A-6 | Gọi sau `openLot` trong cùng transaction. Dòng đủ → `READY`. Cập nhật trạng thái đơn + báo người phụ trách là việc A-6. |
| `lowStockCrossing` / `notifyLowStock` | như cũ | `notifyLowStock` gọi **sau commit**. |

Ledger: `type` ∈ `InventoryTxType`, `referenceType` ∈ `InventoryRefType` (`src/common/constants/inventory-ledger.ts`).

Hàm thuần của track A (A-1, file `src/modules/orders/order-status.ts`):
`deriveLineStatus(line, heldQty)` và `deriveOrderStatus(order, lines)` – mọi chỗ đổi trạng thái đơn
(A-3, A-6, C-1, C-3, D-5) đều gọi qua đây, không tự set `order.status`.

## 2. Đơn hàng – Track A (BE `orders/`), FE Track D (`sales/`)

### Kiểu trả về

```ts
OrderDetail = {
  id, code?: string /* = paymentReference cho đơn cũ */, status: OrderStatus, channel: 'MANUAL' | 'SHOPEE',
  branch: { id, name }, customer: { id, name, phone }, assignee: UserRef | null,
  createdBy: UserRef | null, confirmedBy: UserRef | null, confirmedAt: string | null,
  fulfillmentType: 'TAKEAWAY' | 'STORE_PICKUP' | 'HOME_DELIVERY',
  subtotal, shippingFee, channelFee, vatTotal, discountType, discountValue, grandTotal, depositRequired,
  paymentStatus: OrderPaymentStatus,
  recipientName, recipientPhone, deliveryAddress, requestedDeliveryDate, shipByDate, channelOrderRef,
  note, createdAt, updatedAt,
  items: OrderLine[],
  fulfillments: { id, status, locationId }[], shipments: { id, status, carrierType, trackingCode }[],
  returns: { id, code, status }[],
}
OrderLine = {
  id, productItemId, productName, sku, variantLabel, status: OrderItemStatus, lineType: OrderLineType,
  parentItemId: string | null, quantity, listUnitPrice, unitPrice, discountAmount, lineTotal,
  heldQuantity /* Σ ACTIVE + CONSUMED reservations */, returnedQuantity, sourceLocation: { id, name } | null,
  isCustom, customization: OrderItemCustomization | null,
}
OrderItemCustomization = { lengthCm, widthCm, heightCm, material, color, fabricCode, note, attachmentUrls: string[],
  specs: { name, value, unit? }[] }
UserRef = { id, name, phoneNumber }
```

`OrderListItem` = `OrderDetail` bỏ `items/fulfillments/shipments/returns`, thêm `itemCount`.

### Route

| Route | Quyền | Body / query | Task |
|---|---|---|---|
| `GET /orders` | `orders:read` (+`view_all` để xem mọi chi nhánh) | `page, limit, search` (mã đơn, tên/SĐT khách), `status`, `channel`, `assigneeId`, `branchId`, `fulfillmentType`, `from`, `to` | D-1 |
| `GET /orders/:id` | `orders:read` | → `OrderDetail` | D-3 |
| `POST /orders` | `orders:create` | `CreateOrderDto` dưới. `asDraft: true` → DRAFT (không giữ hàng, `assigneeId` không bắt buộc); ngược lại tạo + xác nhận luôn (B1c). | A-2 |
| `PATCH /orders/:id` | `orders:update` | Sửa đơn **DRAFT** (cùng field với create, trừ `asDraft`). Khác DRAFT → `ORDER_NOT_DRAFT`. | A-2 |
| `POST /orders/:id/confirm` | `orders:confirm` | `{ assigneeId?, sourceLocationId?, lines?: [{ orderItemId, sourceLocationId }] }` – DRAFT / PENDING_CONFIRMATION → CONFIRMED / READY_TO_PACK, giữ hàng từng dòng. | A-3 |
| `PATCH /orders/:id/assignee` | `orders:assign` | `{ assigneeId }` | A-3 |
| `PUT /orders/:id/items/:itemId/customization` | `orders:update` | `OrderItemCustomization` (không có `id`). Lần đầu: tạo ProductItem mới cùng sản phẩm, chuyển dòng sang, nhả hold SKU cũ, `isCustom = true`. Khoá khi YCSX đã SENT → `ORDER_ITEM_CUSTOM_LOCKED`. | A-4 |
| `POST /orders/:id/cancel` | `orders:update` | `{ reason? }` – trước đóng: nhả hold; đã đóng chưa bàn giao: nhập lại đúng lô; đã bàn giao → `ORDER_CANCEL_NOT_ALLOWED`. | A-5, A-7 |
| `PATCH /orders/:id/status`, `POST /orders/:id/pay-offline` | như cũ | **Legacy** (POS cũ) – giữ tới khi A-2 + E-5 thay. | – |

```ts
CreateOrderDto = {
  branchId: string; customerId?: string; customer?: { name: string; phone?: string; address?: string };
  assigneeId?: string;                 // bắt buộc khi !asDraft → ORDER_ASSIGNEE_REQUIRED
  fulfillmentType: FulfillmentType;     // TAKEAWAY = bán tại quầy
  items: {
    productItemId: string; quantity: number;
    unitPrice?: number;                 // giá thoả thuận; bỏ trống = retailPrice
    discountAmount?: number;
    sourceLocationId?: string;          // kho dự kiến xuất; mặc định = Location.defaultFulfillmentLocationId của chi nhánh, rồi chính chi nhánh
    customization?: OrderItemCustomization; // có → dòng custom (A-4)
  }[];
  shippingFee?: number; discountType?: 'ORDER'; discountValue?: number; appliedPromotions?: { promotionId }[];
  depositRequired?: number;
  recipientName?: string; recipientPhone?: string; deliveryAddress?: string; requestedDeliveryDate?: string;
  note?: string; asDraft?: boolean;
  payment?: { method: 'CASH' | 'BANK_TRANSFER' | 'SEPAY'; customerPay?: number }; // chỉ TAKEAWAY, tới E-5
}
```

Combo: dòng `COMBO` (giá) + các dòng con `COMBO_COMPONENT` (giá 0, `parentItemId`) do server bung từ
`ComboComponent` – client chỉ gửi `productItemId` của combo.

## 3. Yêu cầu sản xuất & nhập hàng – Track B

### `ProductionRequest`

```ts
ProductionRequest = {
  id, code /* YCSX000123 */, status: ProductionRequestStatus,
  supplier: { id, supplierName, phoneNumber }, location: { id, name, type },
  expectedReadyDate, sentAt, note, createdBy: UserRef | null, statusUpdatedBy: UserRef | null, statusUpdatedAt,
  createdAt, updatedAt,
  items: { id, productItemId, sku, productName, quantity, receivedQuantity, note,
           orderItem: { id, orderId, orderCode, isCustom } | null }[],
}
```

| Route | Quyền | Body / query | Task |
|---|---|---|---|
| `GET /production-requests` | `production_requests:read` | `page, limit, search` (mã), `status`, `supplierId`, `locationId` | B-4, B-6 |
| `GET /production-requests/:id` | `production_requests:read` | | B-4 |
| `POST /production-requests` | `production_requests:create` | `{ supplierId (WORKSHOP → SUPPLIER_NOT_WORKSHOP), locationId, expectedReadyDate?, note?, items: [{ productItemId, quantity, orderItemId?, note? }] }` – SKU custom bắt buộc `orderItemId` (`PRODUCTION_REQUEST_CUSTOM_LINE_REQUIRED`) | B-4 |
| `PATCH /production-requests/:id` | `production_requests:update` | Như create; chỉ khi DRAFT (`PRODUCTION_REQUEST_LOCKED`) | B-4 |
| `PATCH /production-requests/:id/status` | `production_requests:update` | `{ status: 'SENT' \| 'COMPLETED' \| 'CANCELLED', note? }` – PARTIALLY_RECEIVED / COMPLETED cũng được B-5 tự set khi nhận hàng | B-4 |
| `POST /production-requests/:id/items` | `production_requests:update` | `{ productItemId, quantity, orderItemId? }` – nút "Thêm vào yêu cầu" từ cảnh báo thiếu hàng (DRAFT) | B-6 |
| `DELETE /production-requests/:id` | `production_requests:delete` | chỉ DRAFT | B-4 |
| `GET /production-requests/shortages` | `production_requests:read` | `locationId?` → `Shortage[]` | B-2 |

```ts
Shortage = { locationId, locationName, productItemId, sku, productName,
             available /* stock − reserved */, waitingQuantity /* Σ thiếu của dòng WAITING_STOCK */,
             onOrderQuantity /* Σ (quantity − receivedQuantity) YCSX mở */, shortQuantity /* = cần thêm */ }
```

Cảnh báo thiếu hàng (B-3) gửi qua `NotificationService` + template `src/modules/notifications/templates/production-request.templates.ts`, `referenceId` = `productItemId`, `link` = `/exchange/production-requests?locationId=…&productItemId=…`.

### Nhà cung cấp (B-1)

`Supplier.type: 'GOODS' | 'WORKSHOP'` – thêm vào `POST/PATCH /suppliers` và filter `GET /suppliers?type=`.
Đổi `type` khi NCC đã có phiếu nhập / YCSX → `SUPPLIER_HAS_TRANSACTIONS`.

### Phiếu nhập 2 luồng (B-5) – thêm vào `/stock-movements`

- `POST /stock-movements` (IMPORT): thêm `importSource: 'SUPPLIER' | 'WORKSHOP'` (bắt buộc → `IMPORT_SOURCE_REQUIRED`; lệch loại NCC → `IMPORT_SOURCE_SUPPLIER_MISMATCH`). WORKSHOP: mỗi `details[]` có `productionRequestItemId` (`IMPORT_PRODUCTION_ITEM_REQUIRED` / `_MISMATCH` / `_QTY_EXCEEDS`).
- `PATCH /stock-movements/:id/receive`: `details[]` thêm `defectQuantity?` (≤ `receivedQuantity`, `STOCK_MOVEMENT_DEFECT_QTY_EXCEEDS`) và `defectLocationId?` (mặc định `damagedLocationId` của kho nhận; không có → `LOCATION_DAMAGED_REQUIRED`).
  Phần đạt (`received − defect`) → `openLot` (SUPPLIER/WORKSHOP) + `allocateArrivals` (ưu tiên `productionRequestItem.orderItemId`); phần lỗi → `openLot` tại kho hỏng, `ledger.type = DEFECT`; cập nhật `ProductionRequestItem.receivedQuantity` + trạng thái YCSX. Công nợ NCC tính trên **số thực nhận** như hiện nay.
- Response chi tiết phiếu thêm `importSource`, `details[].productionRequestItemId`, `defectQuantity`, `defectLocation`.

## 4. Đóng hàng & giao hàng – Track C

### `Fulfillment`

```ts
Fulfillment = {
  id, status: FulfillmentStatus, order: { id, code, status, fulfillmentType, customerName, assigneeId },
  location: { id, name }, assignee: UserRef | null, verifiedBy: UserRef | null, verifiedAt,
  dueDate, pickStartedAt, pickedAt, packStartedAt, packedAt, handedOverAt, exceptionNote, createdAt,
  items: { id, orderItemId, productName, sku, quantity, qtyPicked, qtyPacked,
           packagesRequired /* số ProductPackage của SKU, 0 = 1 kiện */ }[],
  packages: { id, code, productPackageId, weightKg, photoUrls: string[], packedBy: UserRef | null, packedAt }[],
}
```

| Route | Quyền | Body | Task |
|---|---|---|---|
| `GET /fulfillments` | `fulfillments:read` | `page, limit, status, locationId, assigneeId, search` | C-6 |
| `GET /fulfillments/ready-orders` | `fulfillments:read` | `locationId?` – đơn READY_TO_PACK chưa có fulfillment | C-6 |
| `GET /fulfillments/:id` | `fulfillments:read` | | C-6 |
| `POST /fulfillments` | `fulfillments:create` | `{ orderId, assigneeId?, dueDate? }` – kho = `sourceLocationId` của các dòng READY; đơn không READY_TO_PACK → `FULFILLMENT_ORDER_NOT_READY`; đã có → `FULFILLMENT_ALREADY_EXISTS` | C-1 |
| `PATCH /fulfillments/:id/items` | `fulfillments:update` | `{ items: [{ orderItemId, qtyPicked?, qtyPacked?, pickedFromId? }] }` (`FULFILLMENT_QTY_EXCEEDS`) | C-1 |
| `POST /fulfillments/:id/packages` | `fulfillments:update` | `{ productPackageId?, weightKg?, photoUrls: string[] }` → code tự sinh | C-1 |
| `POST /fulfillments/:id/verify` | `fulfillments:verify` **hoặc** là người phụ trách đơn (`FULFILLMENT_VERIFY_DENIED`) | `{}` – đủ kiện (`FULFILLMENT_PACKAGES_INCOMPLETE`) → `consume` từng dòng → dòng PACKED, đơn PACKED | C-1 |
| `POST /fulfillments/:id/hand-over` | `fulfillments:update` | `{}` – PACKED → HANDED_OVER, đơn SHIPPING (TAKEAWAY: đơn DELIVERED luôn) | C-2 |
| `POST /fulfillments/:id/cancel` | `fulfillments:update` | `{ note? }` – chỉ trước verify | C-1 |

### `Shipment`

```ts
Shipment = {
  id, status: ShipmentStatus, carrierType: 'INTERNAL' | 'EXTERNAL', carrierName, trackingCode,
  order: { id, code, customerName }, fulfillmentId, driver: UserRef | null,
  recipientName, recipientPhone, deliveryAddress, scheduledDate, scheduledSlot, expectedDeliveryAt, deliveredAt,
  requiresInstallation, installedAt, proofPhotoUrls: string[], shippingCost, note, createdAt,
  events: { id, status, source: 'MANUAL' | 'CARRIER', note, latitude, longitude, createdBy: UserRef | null, occurredAt }[],
}
```

| Route | Quyền | Body | Task |
|---|---|---|---|
| `GET /shipments` | `shipments:read` | `page, limit, status, carrierType, driverId, from, to, search` | C-3 |
| `GET /shipments/mine` | `shipments:deliver` | các lần giao có `driverId` = mình, chưa kết thúc | C-5, C-7 |
| `GET /shipments/:id` | `shipments:read` hoặc là driver | | C-3 |
| `POST /shipments` | `shipments:create` | `{ fulfillmentId (HANDED_OVER → else SHIPMENT_FULFILLMENT_NOT_HANDED_OVER), carrierType, carrierName?, trackingCode?, driverId?, scheduledDate?, scheduledSlot?, expectedDeliveryAt?, requiresInstallation?, shippingCost?, note? }` – địa chỉ copy từ đơn | C-3 |
| `POST /shipments/:id/events` | `shipments:update` | `{ status, note?, latitude?, longitude? }` | C-3 |
| `POST /shipments/:id/deliver` | `shipments:deliver` (driver, INTERNAL, `proofPhotoUrls` ≥ 1 → `SHIPMENT_PROOF_REQUIRED`) hoặc `shipments:update` (EXTERNAL không API, đánh tay) | `{ proofPhotoUrls?: string[], note?, latitude?, longitude? }` → DELIVERED, dòng/đơn DELIVERED qua `deriveOrderStatus` | C-3, C-5 |
| `POST /shipments/:id/fail` | `shipments:update` hoặc driver | `{ note }` → FAILED | C-3 |
| `POST /webhook/carriers/:carrier` | `@Public()` + chữ ký (`CARRIER_WEBHOOK_INVALID`) | payload của hãng → `ShipmentEvent` source CARRIER | C-4 |

Ảnh bằng chứng / ảnh kiện upload qua `POST /uploads` hiện có, gửi URL.

## 5. Hoàn hàng & kho hàng hỏng – Track D

### `OrderReturn`

```ts
OrderReturn = {
  id, code /* DH-HOAN-000123 */, status: OrderReturnStatus, reason: 'CUSTOMER_RETURN' | 'DELIVERY_FAILED',
  order: { id, code, customerName, assigneeId }, shipmentId, note,
  createdBy: UserRef | null, inspectedBy: UserRef | null, inspectedAt, createdAt,
  items: { id, orderItemId, productName, sku, quantity, condition: 'GOOD' | 'DAMAGED' | null,
           location: { id, name } | null, note }[],
}
```

| Route | Quyền | Body | Task |
|---|---|---|---|
| `GET /order-returns` | `returns:read` | `page, limit, status, orderId, search` | D-6 |
| `GET /order-returns/:id` | `returns:read` | | D-6 |
| `POST /order-returns` | `returns:create` **hoặc** là người phụ trách đơn (`ORDER_RETURN_DENIED`) | `{ orderId, reason, shipmentId?, note?, items: [{ orderItemId, quantity, note? }] }` – đơn chưa rời shop → `ORDER_RETURN_ORDER_NOT_RETURNABLE`; vượt `quantity − returnedQuantity` → `ORDER_RETURN_QTY_EXCEEDS` | D-5 |
| `POST /order-returns/:id/inspect` | `returns:inspect` | `{ items: [{ orderItemId, condition, locationId? }] }` – GOOD → `locationId` mặc định kho xuất (sellable); DAMAGED → `damagedLocationId` của kho đó; gọi `returnDrawn` (RETURN_GOOD / RETURN_DAMAGED); cập nhật `returnedQuantity`, dòng RETURNED khi trả đủ, đơn RETURNED khi mọi dòng trả đủ | D-5 |
| `POST /order-returns/:id/cancel` | `returns:cancel` | chỉ PENDING | D-5 |

Hoàn tiền (Payment REFUND) làm ở E-5.

### Kho hàng hỏng (D-4)

`POST/PATCH /warehouses` thêm `isSellable?: boolean` (false = kho hàng hỏng). `POST/PATCH /branches` và
`/warehouses` thêm `damagedLocationId?: string | null` – phải là location `isSellable = false` khác chính
nó, cùng tenant (`LOCATION_DAMAGED_INVALID`). Response chi nhánh / kho trả thêm `isSellable`,
`damagedLocationId`, `defaultFulfillmentLocationId`. Logic đặt trong `LocationService` (dùng chung).

## 6. Phase 2 (phác thảo, chốt lại trước khi làm)

- `sales-channels/`: `GET/POST /sales-channels` (OAuth Shopee), `DELETE /sales-channels/:id`, `GET/POST/DELETE /sales-channels/:id/mappings` (`sales_channels:*`).
- Thanh toán: `GET/POST /orders/:id/payments`, `POST /payments/:id/refund` (`payments:*`).
- Báo cáo lợi nhuận: `GET /stats/order-margins` (`reports:read`).
