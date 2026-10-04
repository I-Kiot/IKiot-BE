# Contract API – Hành trình đơn hàng (Phase 1)

> Chốt ở Phase 0 (P0-6, 2026-10-02), **sửa lại 2026-10-04 theo biên bản họp 02/10/2026**,
> **đồng bộ mã task và chi tiết kỹ thuật với Notion v2 ngày 2026-10-04**.
>
> **Thứ tự nguồn:**
> 1. [`hanh-trinh-don-hang.md`](../../docs/hanh-trinh-don-hang.md) (workspace) – nghiệp vụ.
> 2. Notion **"Task – Hành trình đơn hàng (v2 – map flow)"** – task, phạm vi, chi tiết kỹ thuật đã chốt.
> 3. File này – route, DTO, mã lỗi.
>
> Bên đứng sau lệch bên đứng trước thì bên đứng sau sai. Mã task trong file này là cột **Mã** của
> Notion v2; bước nghiệp vụ ghi dạng **GĐx – By** theo hành trình. Bảng đối chiếu đầy đủ ở **§9**.
>
> **Ngoại lệ (2026-10-04): khoá hàng khi đóng gói.** `hanh-trinh-don-hang.md` và file này đã cập nhật,
> Notion v2 **chưa** (P0-5, B-2, C-1, C-2, C-6, C-9, A-5, A-8 vẫn ghi "không giữ hàng", "đóng hàng chỉ
> cảnh báo, C-2 mới chặn"). Ở những điểm đó, theo hai file trong repo cho tới khi Notion được sửa.
> Cần đổi contract → nhắn Astersa, **không tự sửa route/field của track khác**.
>
> **Phase 1 = luồng tạo đơn bằng tay.** Phần Shopee (đơn `PENDING_CONFIRMATION`, xác nhận đơn
> sàn, ĐVVC bên thứ ba tự cập nhật) chỉ giữ chỗ, làm sau khi luồng tay chạy ổn với nhân viên khách.

## Những gì đổi so với bản 2026-10-02

| Bản cũ | Bản này | Vì sao (hành trình đơn hàng) |
|---|---|---|
| Xác nhận đơn **giữ hàng** (`reserve`), hàng về tự `allocateArrivals` | **Không giữ hàng ở bất kỳ bước nào.** Đã xoá bảng `stock_reservations`, cột `inventories.reserved` và `reserve` / `release` / `consume` / allocateArrivals` bỏ khỏi `InventoryService` (P0-5) | "Không tự động trừ hay giữ tồn kho khi đơn chưa đi" |
| *(sửa 2026-10-04, sau bản trên)* Không giữ hàng ở bước nào | Xác nhận đơn vẫn không giữ hàng, nhưng **đóng gói khoá hàng** (`inventories.locked_stock`, không có bảng giữ hàng) và chặn khi trên kệ không đủ – xem §1 | Quyết định của Astersa 2026-10-04; **`hanh-trinh-don-hang.md` và Notion v2 chưa cập nhật** |
| Trừ kho lúc **verify đóng hàng** (C-1) | Trừ kho lúc **chuyển sang Đang vận chuyển** (`POST /orders/:id/ship`, C-2) – trừ đúng phần đã khoá | GĐ1 – Bước 6 |
| Tạo đơn tay có `asDraft` → `DRAFT` | Bỏ `DRAFT`. Tạo đơn tay **luôn ra `CONFIRMED`**, bắt buộc người phụ trách | GĐ1 – Bước 1 |
| Trạng thái `READY_TO_PACK`, dòng `WAITING_STOCK`/`READY` theo hàng đã giữ | Bỏ. Tình trạng tồn kho của dòng là **thông tin để xem** (`stockCheck`), không phải trạng thái | GĐ1 – Bước 3 |
| — | Thêm **`PICKED_UP`** (ĐVVC đã lấy hàng) giữa Đóng đơn và Đang vận chuyển | Trạng thái chính |
| `DELIVERED` | **`RECEIVED`** (Đã nhận hàng) – theo Notion P0-2 | GĐ1 – Bước 7 |
| — | Thêm **tiền cọc** (số tiền hoặc %), **còn phải thu**, **theo dõi tiền mặt shipper nộp lại** | GĐ1 – Bước 1, 7 |
| — | Thêm **tag ưu tiên** trên đơn (`NORMAL` / `HIGH` / `URGENT`, P0-8) | GĐ1 – Bước 3 |
| Danh sách thiếu hàng theo dòng `WAITING_STOCK` | **Danh sách cần sản xuất gộp theo mặt hàng**, tính lúc xem; đặt xưởng bằng **YCSX** (giữ), nhận hàng xưởng qua `POST /production-requests/:id/receive` (người duyệt nhập "đã nhận / đã đặt") – chỉ lúc đó tồn kho tăng | GĐ1 – Bước 4 |
| Fulfillment pick/pack/kiện/verify qua `/fulfillments/*` | Đóng đơn qua **`POST /orders/:id/pack`**, vẫn tạo **FulfillmentPackage** + ghi `verifiedBy` (C-1) | GĐ1 – Bước 5 |
| `OrderReturn` PENDING → INSPECTED | REQUESTED → INSPECTING → COMPLETED | GĐ2 |

Giữ như bản 2026-10-02 (Notion vẫn còn task): `Supplier.type` GOODS / WORKSHOP (B-1), phiếu nhập
NCC / xưởng có `importSource` và hàng lỗi `defectQuantity` → `defectLocationId` (B-5, B-7) – **không**
gọi `allocateArrivals` nữa.

Mục **§7** liệt kê phần đã rút khỏi Phase 1 để track nào đang làm dở biết mà dừng.

## 0. Quy ước chung

| | |
|---|---|
| Envelope thành công | `{ success: true, message, data }`; list: `{ success, data: T[], pagination: { page, limit, total, totalPages } }` |
| Lỗi | `{ success: false, statusCode, code, message, errors? }` – client **chỉ rẽ nhánh theo `code`** (`src/common/errors/error-codes.ts`, append-only) |
| Id | `id` (uuid). Không bao giờ `_id`. |
| Phân trang / tìm kiếm | `page`, `limit`, `search` |
| Tiền | `number` (VND, Decimal ở DB, serialize ra number) |
| Thời gian | ISO string, `Timestamptz`; ngày thuần (`requestedDeliveryDate`, `scheduledDate`) là `YYYY-MM-DD` |
| Danh tính | `tenantId`, người thao tác **luôn lấy từ token**, không bao giờ nhận từ body |
| Trạng thái | Chỉ dùng hằng trong `src/common/constants/*-status.ts`, `inventory-ledger.ts` (P0-2) – không viết chuỗi tay |
| Cross-tenant | 404, không 403 |
| Quyền | Mỗi route ghi `@Permissions(resource, action)` như bảng dưới + `@ApiBearerAuth('bearer')`. Cặp đánh dấu **(mới)** chưa có trong seed – xem §6. |
| Cột Task | `BE · FE` – mã task Notion v2 phía BE rồi phía FE |

**Location:** `Branch.id = Warehouse.id = Location.id`. Mọi field `locationId` / `sourceLocationId` /
`damagedLocationId` là id của Location (chi nhánh hay kho đều được, trừ chỗ ghi rõ).

## 1. Tồn kho – nguyên tắc và hàm dùng chung (`InventoryService`, P0-5, chỉ gọi, không sửa)

**Nguyên tắc:** tồn kho chỉ đổi khi hàng thật sự di chuyển –
tăng khi **nhận hàng xưởng giao về theo YCSX** (§3) hoặc nhập NCC / hoàn hàng nguyên vẹn,
giảm khi đơn **chuyển sang Đang vận chuyển** (§2). Tạo, sửa, hủy trước khi đóng gói:
**không đụng tồn kho**. Stock = 0 vẫn tạo / gán người phụ trách bình thường.

**Khoá hàng khi đóng gói (2026-10-04, thay cho "không giữ hàng ở bước nào"):** `inventories` có
thêm `locked_stock`. Tổng `stock` (= `totalStock`) gồm hàng trên kệ **và** hàng đã đóng gói cho đơn
chưa đi; **trên kệ** `actualStock = stock − locked_stock` – tính khi đọc, không lưu cột.

| Bước | `stock` | `locked_stock` | Chặn |
|---|---|---|---|
| `CONFIRMED → PACKED` (verify đóng hàng) | – | `+ quantity` | `actualStock < quantity` ở **bất kỳ** dòng nào → `INSUFFICIENT_STOCK`, gom mọi dòng thiếu |
| `PACKED → PICKED_UP` | – | – | – |
| `PICKED_UP → SHIPPING` | `− quantity` | `− quantity` | khoá không đủ → `INVENTORY_LOCK_MISMATCH` (đơn chưa đóng gói ở kho đó) |
| hủy / giảm số lượng khi đã `PACKED` / `PICKED_UP` | – | `− quantity` | như trên |

Bán quầy, xuất chuyển kho, kiểm kê thiếu và đóng gói đơn khác chỉ lấy được phần **trên kệ**. Cảnh
báo sắp hết so `minStock` với **trên kệ**, nên đóng gói cũng có thể bắn cảnh báo. Không có bảng giữ
hàng: chứng từ khoá là `Fulfillment` `PACKED` / `HANDED_OVER` của đơn chưa ship –
`locked_stock = Σ FulfillmentItem.quantity` của các fulfillment đó, theo (location, SKU).

Hệ quả: nhiều đơn **đã xác nhận** cùng cần một mặt hàng vẫn là chuyện bình thường – **đơn nào đóng gói
trước do người dùng quyết** (tag ưu tiên, ngày hẹn giao); hệ thống chặn ở cửa `pack` (đủ hàng trên kệ)
và `ship` (đúng phần đã khoá).

Tất cả nhận `tx` (Prisma transaction client) của caller. Bất biến: Σ `lot.remainingQuantity` = `inventories.stock`, và `0 ≤ locked_stock ≤ stock` (CHECK SQL).

| Hàm | Dùng ở | Ghi chú |
|---|---|---|
| `lockStock(tx, [{ tenantId, locationId, productItemId, quantity, label }])` → `Inventory[]` | `POST /orders/:id/pack` (C-1, `FulfillmentService.packOrder`) | Khoá từng dòng trong câu `UPDATE` có điều kiện `stock − locked_stock ≥ quantity`; thử hết các dòng rồi báo **một** `INSUFFICIENT_STOCK` liệt kê mọi dòng thiếu. Không ghi sổ kho (hàng chưa đi). |
| `shipLockedStock(tx, { tenantId, locationId, productItemId, quantity, label, ledger })` | `POST /orders/:id/ship` (C-2) | Trừ `stock` và `locked_stock` cùng lúc + rút lô FIFO. Luồng đơn gọi với `ledger: { type: SALE, referenceType: ORDER, referenceId: orderId, orderItemId, createdById }` – **bắt buộc có `orderItemId`** thì hoàn hàng mới tìm lại đúng lô. Khoá không đủ → `INVENTORY_LOCK_MISMATCH`. |
| `releaseLockedStock(tx, { tenantId, locationId, productItemId, quantity, label })` | hủy / sửa đơn đã `PACKED` (A-5, A-8) | Trả phần khoá về kệ, không ghi sổ. Khoá không đủ → `INVENTORY_LOCK_MISMATCH`. |
| `deductStock(tx, { tenantId, locationId, productItemId, quantity, label, ledger })` | bán quầy, xuất chuyển kho, kiểm kê thiếu | Trừ hàng **trên kệ** + rút lô FIFO trong cùng câu `UPDATE` có điều kiện `stock − locked_stock ≥ quantity`. Thiếu → `INSUFFICIENT_STOCK`. **Không** dùng cho đơn đã đóng gói. |
| `openLot(tx, { tenantId, locationId, productItemId, quantity, unitCost?, sourceType, supplierId?, orderItemId?, ledger, … })` → `{ inventory, lotId }` | §3 nhận hàng xưởng (B-5), nhập NCC (B-5) | Hàng mới về. Hàng xưởng: `sourceType: WORKSHOP`, `supplierId` = xưởng, `importItemId` + `productionRequestItemId` của dòng, `ledger: { type: IMPORT, referenceType: STOCK_MOVEMENT, referenceId: <phiếu nhập> }`. Dòng YCSX gắn đơn custom: truyền `orderItemId` để lô gắn với dòng đơn đó. |
| `returnDrawn(tx, { tenantId, productItemId, toLocationId, quantity, drawnBy: { orderItemId }, ledger, ifNeverDrawn? })` | §5 hoàn hàng (D-5) | Hàng quay lại đúng lô đã rút lúc `ship`. Nguyên vẹn: `RETURN_GOOD` vào kho bán; hỏng: `RETURN_DAMAGED` vào kho hỏng. |
| `lowStockCrossing` / `notifyLowStock` | như cũ | `notifyLowStock` gọi **sau commit**. |

**Giá vốn dòng hàng:** `deductStock` tự lo khi `ledger.type = SALE` có `orderItemId`: rút lô custom
của đúng dòng đó trước, rồi tính lại `OrderItem.unitCostPrice` từ các dòng sổ kho SALE của dòng.

Ledger: `type` ∈ `InventoryTxType`, `referenceType` ∈ `InventoryRefType` (`src/common/constants/inventory-ledger.ts`).

## 2. Đơn hàng – Track A, C, D, E (BE `orders/`, FE `sales/`)

Module `orders/` có route của nhiều track. Cột **Task** của từng route cho biết track nào làm:

| Track (Notion v2) | Route trong mục này |
|---|---|
| **A** – Đơn | `GET /orders*` (A-9), `POST /orders` (A-2), `PATCH /orders/:id*` (A-8), customization (A-4), `cancel` (A-5), `confirm` (A-3), `confirm-remittance` (A-10), `assertTransition` (A-1) |
| **C** – Đóng hàng & giao | `POST /orders/:id/pack` (C-1 · C-6), `POST /orders/:id/ship` (C-2 · C-9) |
| **D** – Màn hình đơn | FE: D-1, D-2, D-3, D-7, D-8, D-9 |
| **E** – Thanh toán | `Payment` cọc, route legacy (E-5 · E-6) |

### Trạng thái

```
PENDING_CONFIRMATION (chỉ Shopee – sau)
        │ POST /orders/:id/confirm                                  (A-3)
        ▼
CONFIRMED ──POST /orders/:id/pack──▶ PACKED ──POST /shipments──▶ PICKED_UP
(đơn tay tạo ra ở đây, A-2)  (C-1: khoá hàng, thiếu là chặn)     (C-2)       (ĐVVC đã lấy hàng)
                                                                     │ POST /orders/:id/ship  (C-2) ← trừ tồn kho (đúng phần đã khoá)
                                                                     ▼
                                                                  SHIPPING ──deliver, tiền mặt──▶ RECEIVED ──confirm-remittance (A-10)──▶ COMPLETED
                                                                     └──deliver, QR / không còn phải thu (C-5 + A-10)──────────────────▶ COMPLETED
```

| `OrderStatus` | Nhãn | Ghi chú |
|---|---|---|
| `PENDING_CONFIRMATION` | Chờ xác nhận | Chỉ đơn Shopee *(sau)*. Chưa có người phụ trách. |
| `CONFIRMED` | Xác nhận | Đơn tay sinh ra ở đây. |
| `PACKED` | Đóng đơn | Đã đóng gói, chờ shipper / ĐVVC đến lấy. **Hàng đã khoá** (`locked_stock`), chưa trừ `stock`. |
| `PICKED_UP` | Đơn vị vận chuyển đã lấy hàng | Có `Shipment`. Hàng vẫn khoá, chưa trừ kho. |
| `SHIPPING` | Đang vận chuyển | **Tồn kho đã trừ.** |
| `RECEIVED` | Đã nhận hàng | Chỉ khi shipper thu **tiền mặt**: chờ chủ xác nhận đã nhận đủ tiền. |
| `COMPLETED` | Hoàn thành | Kết thúc GĐ1. Hoàn hàng (GĐ2) mở từ đây. |
| `CANCELLED` | Đã hủy | **Chưa chốt** (A-5) – xem `POST /orders/:id/cancel`. |
| `RETURNED` | Đã hoàn | Mọi dòng đã hoàn đủ (§5). |

Bỏ khỏi `OrderStatus`: `DRAFT`, `READY_TO_PACK`, `DELIVERED` (và `PENDING` legacy khi A-2 xong). Thêm
`PICKED_UP`, `RECEIVED`. `OrderItemStatus` rút về `PENDING | SHIPPED | RETURNED | CANCELLED` – dòng không
còn trạng thái theo hàng đã giữ. `deriveOrderStatus` / `deriveLineStatus`
(`src/modules/orders/order-status.ts`) bỏ; trạng thái đơn đổi bằng **một hàm chuyển trạng thái**
`assertTransition(from, to)` trong cùng file (A-1), mọi route bên dưới đi qua nó (sai bước →
`ORDER_STATUS_TRANSITION_INVALID`).

### Kiểu trả về

```ts
OrderDetail = {
  id, code: string, status: OrderStatus, channel: 'MANUAL' | 'SHOPEE',
  priority: OrderPriority,            // tag ưu tiên: 'NORMAL' | 'HIGH' | 'URGENT' (danh sách cố định để sắp xếp được)
  branch: { id, name }, customer: { id, name, phone }, assignee: UserRef | null,
  createdBy: UserRef | null, confirmedBy: UserRef | null, confirmedAt: string | null,
  shippedBy: UserRef | null, shippedAt: string | null,   // người xác nhận Đang vận chuyển (trừ kho)
  fulfillmentType: 'STORE_PICKUP' | 'HOME_DELIVERY',
  subtotal, shippingFee, vatTotal, discountType, discountValue, grandTotal,
  deposit: { amount: number, percent: number | null } | null,  // percent = null khi nhập theo số tiền
  amountDue,                          // = grandTotal − deposit.amount; số shipper thu khi giao
  collection: {                       // null tới khi giao
    method: 'CASH' | 'BANK_TRANSFER_QR' | 'NONE', amount, collectedBy: UserRef | null, collectedAt,
    cashRemittanceStatus: 'NOT_APPLICABLE' | 'PENDING' | 'RECEIVED',  // tiền mặt shipper đã nộp lại chưa – lưu ở Payment.remittanceStatus
    remittanceConfirmedBy: UserRef | null, remittanceConfirmedAt: string | null,
  } | null,
  paymentStatus: OrderPaymentStatus,  // UNPAID → PARTIALLY_PAID (đã cọc) → PAID
  recipientName, recipientPhone, deliveryAddress, requestedDeliveryDate, channelOrderRef,
  note, createdAt, updatedAt,
  items: OrderLine[],
  shipments: { id, status, carrierType, carrierName, trackingCode, driver: UserRef | null }[],
  returns: { id, code, status }[],
}
OrderLine = {
  id, productItemId, productName, sku, variantLabel, status: OrderItemStatus, lineType: OrderLineType,
  parentItemId: string | null, quantity, listUnitPrice, unitPrice, discountAmount, lineTotal,
  returnedQuantity, sourceLocation: { id, name } | null,
  isCustom, customization: OrderItemCustomization | null,
  stockCheck: StockCheck | null,      // null với dòng COMBO / SERVICE và sau khi đã ship
}
StockCheck = {                        // tính lúc đọc (B-2), KHÔNG phải số đã giữ cho đơn này
  status: 'ENOUGH' | 'PARTIAL' | 'OUT',   // Đủ hàng / Thiếu một phần / Hết hàng (P0-2)
  stock, shortQuantity,               // stock = trên kệ (stock − locked_stock); shortQuantity = max(0, quantity − stock); kho nào: CHỜ CHỐT (B-2)
}
OrderItemCustomization = { lengthCm, widthCm, heightCm, material, color, fabricCode, note, attachmentUrls: string[],
  specs: { name, value, unit? }[] }
UserRef = { id, name, phoneNumber }
```

`OrderListItem` = `OrderDetail` bỏ `items/shipments/returns`, thêm `itemCount` và
`stockSummary: 'ENOUGH' | 'PARTIAL' | 'OUT' | null` (dòng tệ nhất; null khi đã ship) –
để danh sách lọc được "đơn đi được ngay".

`stockCheck` so **từng dòng riêng với hàng trên kệ** (đã trừ phần khoá cho các đơn **đã đóng gói**),
không trừ cho các đơn chưa đóng gói: hai đơn `CONFIRMED` cùng cần 1 cái tủ và kệ còn 1 thì cả hai
đều hiện "Đủ hàng"; đơn nào đóng gói trước lấy cái tủ, đơn kia chuyển "Hết hàng" và bị chặn ở `pack`.
Người dùng chọn đơn đi trước; con số tổng thiếu (đã trừ phần đã đặt xưởng) nằm ở danh sách cần sản xuất (§3).

**Kho dùng để tính `stock`** (theo `sourceLocationId` của dòng, hay tổng các kho): **chờ chốt** (Notion
B-2). Mọi chỗ trong file này ghi "tại `sourceLocation`" là đề xuất cho tới khi chốt.

### Route

| Route | Quyền | Body / query | Task (BE · FE) |
|---|---|---|---|
| `GET /orders` | `orders:read` (+`view_all` để xem mọi chi nhánh) | `page, limit, search` (mã đơn, tên/SĐT khách), `status`, `channel`, `assigneeId`, `branchId`, `priority`, `stockSummary`, `cashRemittanceStatus`, `from`, `to`, `sort` (`createdAt` \| `requestedDeliveryDate` \| `priority`) | A-9 · D-1 |
| `GET /orders/:id` | `orders:read` | → `OrderDetail` | A-9 · D-3 |
| `POST /orders` | `orders:create` | `CreateOrderDto` dưới → đơn **`CONFIRMED`**, `confirmedBy` = người tạo. Không giữ hàng, không chặn vì tồn kho. Ghi `Payment` cọc (E-5). | A-2 · D-2 |
| `PATCH /orders/:id` | `orders:update` | Cùng field với create. Chỉ khi đơn **chưa Đang vận chuyển** (`CONFIRMED` / `PACKED` / `PICKED_UP`) → khác: `ORDER_NOT_EDITABLE`. Đổi item / giảm giá / phí ship thì tính lại `grandTotal`, `deposit.amount` (nếu cọc theo %) và `amountDue`; danh sách cần sản xuất tự phản ánh vì tính lúc xem (B-4). Đơn đã `PACKED` / `PICKED_UP` mà đổi item / số lượng: hàng đã khoá phải khớp lại – **chờ chốt**: chặn sửa item sau khi đóng gói (`ORDER_NOT_EDITABLE`), hay giảm thì `releaseLockedStock`, tăng thì `lockStock` (thiếu → chặn) và đóng gói lại. | A-8 · D-7 |
| `PATCH /orders/:id/assignee` | `orders:update` | `{ assigneeId }` – khi đơn chưa Đang vận chuyển | A-8 · D-7 |
| `PATCH /orders/:id/priority` | `orders:update` | `{ priority }` – khi đơn chưa Đang vận chuyển (không cần mở form sửa đơn) | A-8 · D-7 |
| `PUT /orders/:id/items/:itemId/customization` | `orders:update` | `OrderItemCustomization`. Lần đầu: tạo ProductItem mới cùng sản phẩm, chuyển dòng sang, `isCustom = true`. Chỉ khi `CONFIRMED`; khoá khi dòng đã nằm trong một YCSX đã `SENT` (§3) → `ORDER_ITEM_CUSTOM_LOCKED`. | A-4 · D-2 (đơn tay), D-8 (Shopee, Phase 2) |
| `POST /orders/:id/pack` | `orders:pack` **(mới)** | `{ note? }` (ghi vào `Fulfillment.exceptionNote`) – `CONFIRMED` → `PACKED`. Trong **một transaction**: nhận đơn bằng `updateMany(status: CONFIRMED)` (thua → `ORDER_STATUS_CONFLICT` 409), tạo `Fulfillment` `PACKED` + `FulfillmentItem` + **FulfillmentPackage tự sinh** (mỗi đơn vị × mỗi `ProductPackage` của SKU, không khai báo = 1 thùng; mã `PK…`), ghi `verifiedBy` = người bấm. **Khoá hàng** (`lockStock`) từng dòng `STOCKED_LINE_TYPES` tại kho đóng gói, cùng transaction; dòng nào `actualStock < quantity` → `INSUFFICIENT_STOCK` (400) liệt kê mọi dòng thiếu, không khoá dòng nào. Không trừ `stock`. `notifyLowStock` sau commit. Kho đóng gói = `sourceLocationId` chung của các dòng (thiếu / nhiều kho → `FULFILLMENT_ORDER_NOT_READY`); STAFF chỉ đóng ở nơi được phân công (`FULFILLMENT_LOCATION_DENIED`). Đơn không ở `CONFIRMED` → `ORDER_STATUS_TRANSITION_INVALID` (tạm, tới khi có A-1). Trả về Fulfillment kèm `items`, `packages`. Dòng đơn giữ `PENDING`. Test: `test/order-pack.e2e-spec.ts`. | C-1 · C-6 |
| `POST /orders/:id/ship` | `orders:ship` **(mới)** | `{ note? }` – `PICKED_UP` → `SHIPPING`. Trong **một transaction**: hàng đã được khoá lúc `pack`, nên `shipLockedStock` từng dòng (trừ `stock` và `locked_stock`); khoá không khớp → `INVENTORY_LOCK_MISMATCH` (409) – lỗi dữ liệu, không phải thiếu hàng. *(Bản trước: gom dòng thiếu → `ORDER_SHIP_INSUFFICIENT_STOCK`; không còn cần vì `pack` đã chặn.)* Áp cho từng dòng `STOCKED_LINE_TYPES` tại `sourceLocationId` (combo trừ từng dòng con), dòng → `SHIPPED`, ghi `unitCostPrice`, `shippedBy/At`, shipment đang mở `PICKED_UP` → `IN_TRANSIT`. `notifyLowStock` sau commit. | C-2 · C-9 |
| `POST /orders/:id/confirm-remittance` | `orders:confirm_cash` **(mới)** | `{ amount, note? }` – `RECEIVED` + `cashRemittanceStatus = PENDING` → `RECEIVED` (tiền), đơn `COMPLETED`. `amount` ≠ số shipper đã thu → `ORDER_REMITTANCE_AMOUNT_MISMATCH` (chủ phải nhận **đủ**). | A-10 · D-9 |
| `POST /orders/:id/confirm` | `orders:confirm` | *(Shopee – sau)* `{ assigneeId, lines?: [{ orderItemId, sourceLocationId?, customization? }] }` – `PENDING_CONFIRMATION` → `CONFIRMED`. Không giữ hàng. | A-3 · D-3 (Phase 2) |
| `POST /orders/:id/cancel` | `orders:update` | `{ reason? }` – **chưa làm tới khi chốt** (Notion A-5, §8). Đề xuất để chốt: cho phép `CONFIRMED` / `PACKED` / `PICKED_UP` (chưa trừ kho; đơn `PACKED` / `PICKED_UP` thì `releaseLockedStock` trả phần khoá về kệ, fulfillment → `CANCELLED`; shipment đang mở → `CANCELLED`); từ `SHIPPING` trở đi → `ORDER_CANCEL_NOT_ALLOWED` (đi đường hoàn hàng). Tiền cọc và dòng YCSX của đơn hủy (dòng custom): chờ chốt. | A-5 · – |
| `PATCH /orders/:id/status`, `POST /orders/:id/pay-offline` | như cũ | **POS bán tại quầy** – vẫn dùng, ngoài hành trình. | E-5 · E-6 |

```ts
CreateOrderDto = {
  branchId: string; customerId?: string; customer?: { name: string; phone?: string; address?: string };
  assigneeId: string;                   // bắt buộc – chọn ngay trên form (ORDER_ASSIGNEE_REQUIRED / _INVALID)
  fulfillmentType: 'STORE_PICKUP' | 'HOME_DELIVERY';
  priority?: OrderPriority;             // mặc định NORMAL
  items: {
    productItemId: string; quantity: number;
    unitPrice?: number;                 // giá thoả thuận; bỏ trống = retailPrice
    discountAmount?: number;
    sourceLocationId?: string;          // kho dự kiến xuất; mặc định = Location.defaultFulfillmentLocationId của chi nhánh, rồi chính chi nhánh
    customization?: OrderItemCustomization; // có → dòng custom (A-4)
  }[];
  shippingFee?: number; discountType?: 'ORDER'; discountValue?: number; appliedPromotions?: { promotionId }[];
  deposit?: { type: 'AMOUNT' | 'PERCENT'; value: number; method: 'CASH' | 'BANK_TRANSFER' };
  recipientName?: string; recipientPhone?: string; deliveryAddress?: string;
  requestedDeliveryDate?: string;       // thời gian khách hẹn giao (GĐ1 – Bước 3)
  note?: string;
}
```

**Tiền cọc** (chỉ đơn tay, A-2 · D-2; ghi Payment qua E-5):
- `PERCENT`: `0 < value ≤ 100`, tính trên `grandTotal` (đã trừ giảm giá), làm tròn tới đồng. Lưu cả
  `depositAmount` lẫn `depositPercent`. `AMOUNT`: lưu `depositAmount`, `depositPercent = null`.
- `depositAmount > grandTotal` → `ORDER_DEPOSIT_EXCEEDS_TOTAL`.
- Ghi một `Payment { kind: DEPOSIT, status: PAID, method }` cùng transaction tạo đơn → `paymentStatus`
  = `PARTIALLY_PAID` (hoặc `PAID` nếu cọc 100%). Client **không** gửi `amountDue` – server tính.
- Sửa đơn khi cọc theo % → số tiền cọc tính lại theo tổng mới **nhưng tiền đã thu không tự đổi**:
  nếu số mới lệch `Payment` DEPOSIT đã ghi thì trả `ORDER_DEPOSIT_CHANGED` kèm số chênh, FE hỏi lại
  người dùng. *(Cách xử lý chênh lệch: chờ chốt cùng phần hủy đơn.)*

Combo: dòng `COMBO` (giá) + các dòng con `COMBO_COMPONENT` (giá 0, `parentItemId`) do server bung từ
`ComboComponent` – client chỉ gửi `productItemId` của combo. `stockCheck` và trừ kho đi theo **từng
dòng con**; thiếu một món không chặn hiển thị các món còn lại.

**Phạm vi:** đơn tạo tay (`MANUAL`) và đơn Shopee đều là **đơn khách đặt qua mạng** – hành trình này chỉ nói về hai loại đó. **Bán tại quầy là POS**, vẫn dùng song song, không đi qua hành trình: đơn POS lưu `fulfillmentType: TAKEAWAY`, thanh toán và trừ tồn ngay lúc bán qua các route legacy bên dưới, và **không** được hiện trong danh sách đơn của hành trình (`GET /orders` của hành trình lọc bỏ `TAKEAWAY`).

## 3. Danh sách cần sản xuất, yêu cầu sản xuất & nhận hàng xưởng – Track B, D (D-4 kho hàng hỏng)

Luồng (hành trình GĐ1 – Bước 4): **danh sách cần sản xuất** (tính lúc xem) → nhân viên lập **yêu cầu
sản xuất (YCSX)** cho một **xưởng**, chỉ định **kho / chi nhánh nhận hàng** → xưởng giao về đó →
**người duyệt nhập số đã nhận / số đã đặt** → **tồn kho của nơi nhận mới tăng**. Hàng về kho mà đơn xuất
từ chi nhánh thì chuyển tiếp bằng phiếu chuyển kho (`/stock-movements` EXPORT) như hiện nay. Hệ thống
không tự gửi cho xưởng. Nhập hàng từ NCC thường (`importSource: SUPPLIER`) **không đổi**.

### Danh sách cần sản xuất (B-4) – không có bảng, tính lúc xem

Một dòng = một cặp **(location, productItemId)**. Dòng custom có ProductItem riêng (A-4) nên tự nhiên
thành dòng riêng, mang theo thông số thiết kế.

- `demandQuantity` = Σ `quantity` của các dòng có tồn kho (`STOCKED_LINE_TYPES`) thuộc đơn
  `UNSHIPPED_ORDER_STATUSES` (`CONFIRMED` / `PACKED` / `PICKED_UP`) có `sourceLocationId` = location.
- `stock` = tồn tại location.
- `onOrderQuantity` = Σ (`quantity − receivedQuantity`) của dòng YCSX còn mở (`SENT` /
  `PARTIALLY_RECEIVED`) có `ProductionRequest.locationId` = location – đã đặt xưởng, chưa về.
- `draftQuantity` = như trên nhưng YCSX `DRAFT` – đã lập, chưa gửi.
- `shortQuantity` = `max(0, demandQuantity − stock − onOrderQuantity − draftQuantity)` – **còn thiếu, chưa đặt**.

```ts
ProductionListRow = {
  location: { id, name, type }, productItemId, sku, productName, variantLabel,
  isCustom, customization: OrderItemCustomization | null,
  stock, demandQuantity, onOrderQuantity, draftQuantity, shortQuantity,
  orders: { orderId, orderCode, orderItemId, quantity, priority, requestedDeliveryDate,
            assignee: UserRef | null, status: OrderStatus }[],   // sắp: priority giảm dần, rồi requestedDeliveryDate
  requests: { id, code, status, supplierName, quantity, receivedQuantity, expectedReadyDate }[], // YCSX mở cho dòng này
}
```

| Route | Quyền | Query | Task (BE · FE) |
|---|---|---|---|
| `GET /production-list` | `production_requests:read` | `locationId?`, `search?` (SKU, tên), `onlyShort?` (mặc định `true`: chỉ dòng `shortQuantity > 0`) → `ProductionListRow[]` | B-4 · B-6 |

**Đơn ở chi nhánh, hàng xưởng về kho:** dòng thiếu nằm ở `sourceLocationId` của dòng đơn. YCSX giao về
kho khác thì phần đặt **không** trừ vào dòng thiếu của chi nhánh cho tới khi chuyển kho xong – xem §8.

### `ProductionRequest` – YCSX (B-4)

```ts
ProductionRequest = {
  id, code /* YCSX000123 */, status: ProductionRequestStatus,   // DRAFT → SENT → PARTIALLY_RECEIVED → COMPLETED | CANCELLED
  supplier: { id, supplierName, phoneNumber } /* xưởng */, location: { id, name, type } /* nơi nhận: kho hoặc chi nhánh */,
  expectedReadyDate, sentAt, note, createdBy: UserRef | null, statusUpdatedBy: UserRef | null, statusUpdatedAt,
  createdAt, updatedAt,
  items: { id, productItemId, sku, productName, quantity, receivedQuantity, note,
           orderItem: { id, orderId, orderCode, isCustom } | null }[],
  receipts: { stockMovementId, code, receivedBy: UserRef | null, receivedAt }[],   // các lần nhận hàng
}
```

| Route | Quyền | Body / query | Task (BE · FE) |
|---|---|---|---|
| `GET /production-requests` | `production_requests:read` | `page, limit, search` (mã), `status`, `supplierId`, `locationId` | B-4 · B-6 |
| `GET /production-requests/:id` | `production_requests:read` | | B-4 · B-6 |
| `POST /production-requests` | `production_requests:create` | `{ supplierId, locationId, expectedReadyDate?, note?, items: [{ productItemId, quantity, orderItemId?, note? }] }` – `supplierId` phải là xưởng (`SUPPLIER_NOT_WORKSHOP`); `locationId` kho hoặc chi nhánh, sellable (`LOCATION_NOT_SELLABLE`); SKU custom bắt buộc `orderItemId` (`PRODUCTION_REQUEST_CUSTOM_LINE_REQUIRED`) → `DRAFT` | B-4 · B-6 |
| `PATCH /production-requests/:id` | `production_requests:update` | Như create; chỉ khi `DRAFT` (`PRODUCTION_REQUEST_LOCKED`) | B-4 · B-6 |
| `POST /production-requests/:id/items` | `production_requests:update` | `{ productItemId, quantity, orderItemId? }` – nút "Thêm vào yêu cầu" từ danh sách cần sản xuất (chỉ `DRAFT`) | B-4 · B-6 |
| `PATCH /production-requests/:id/status` | `production_requests:update` | `{ status: 'SENT' \| 'CANCELLED', note? }` – `SENT` = đã gửi xưởng (ghi `sentAt`); hủy chỉ khi chưa nhận gì. `PARTIALLY_RECEIVED` / `COMPLETED` do `receive` tự set (`PRODUCTION_REQUEST_STATUS_INVALID`) | B-4 · B-6 |
| `DELETE /production-requests/:id` | `production_requests:delete` | chỉ `DRAFT` | B-4 · B-6 |
| `POST /production-requests/:id/receive` | `production:receive` **(mới)** | `ReceiveProductionDto` dưới – YCSX phải `SENT` / `PARTIALLY_RECEIVED` | B-5 · B-7 |

```ts
ReceiveProductionDto = {
  items: { productionRequestItemId: string; receivedQuantity: number;   // lần này nhận bao nhiêu (≥ 0)
           defectQuantity?: number;                                     // trong đó bao nhiêu lỗi (≤ receivedQuantity)
           unitCost?: number }[];                                       // giá xưởng; bỏ trống = costPrice của SKU
  defectLocationId?: string;   // mặc định damagedLocationId của nơi nhận (LOCATION_DAMAGED_REQUIRED nếu có hàng lỗi mà không có)
  note?: string;
}
```

`receive` – **một transaction**, là chỗ duy nhất hàng xưởng vào kho:
1. Kiểm: Σ đã nhận + lần này ≤ `quantity` của dòng (`IMPORT_PRODUCTION_QTY_EXCEEDS`); dòng thuộc YCSX này
   (`IMPORT_PRODUCTION_ITEM_MISMATCH`); có ít nhất một dòng > 0.
2. Ghi một **phiếu nhập** `StockMovementRequest` `IMPORT`, `importSource: WORKSHOP`, `supplierId` = xưởng,
   `toLocation` = `ProductionRequest.locationId`, trạng thái đã nhận, `receivedBy` = người duyệt; mỗi dòng mang
   `productionRequestItemId`, `receivedQuantity`, `defectQuantity`, `defectLocationId`. Phiếu này hiện trong
   danh sách `/stock-movements` như mọi phiếu nhập – **không** tạo được bằng `POST /stock-movements`
   (`importSource: WORKSHOP` ở đó → `IMPORT_WORKSHOP_VIA_PRODUCTION_REQUEST`).
3. Phần đạt (`received − defect`) → `openLot` tại nơi nhận (§1) – **tồn kho tăng ở đây**; phần lỗi →
   `openLot` tại kho hỏng, `ledger.type = DEFECT`.
4. Cộng `ProductionRequestItem.receivedQuantity`; YCSX → `PARTIALLY_RECEIVED`, hoặc `COMPLETED` khi mọi dòng đủ.
5. Sau commit: `notifyLowStock`, báo người phụ trách các đơn đang chờ mặt hàng đó tại nơi nhận (B-3).

Công nợ xưởng: theo số **đạt** × `unitCost`, như công nợ NCC của phiếu nhập hiện nay.

**Cảnh báo thiếu hàng (B-3):** `NotificationService` + template
`src/modules/notifications/templates/production-request.templates.ts`, `referenceId` = `productItemId`,
`link` = `/exchange/production-list?locationId=…&productItemId=…`. Bắn khi tạo / sửa đơn làm một dòng
chuyển từ `shortQuantity = 0` sang `> 0` (edge-triggered như `crossedLowStock`), và báo người phụ trách
các đơn liên quan khi nhận hàng xưởng xong.

### Nhà cung cấp, xưởng và phiếu nhập NCC (B-1, B-5, B-7) – giữ

`Supplier.type` GOODS (NCC) / WORKSHOP (xưởng) (B-1). Phiếu nhập NCC trên `/stock-movements` không đổi
(`importSource: SUPPLIER`, hàng lỗi `defectQuantity` → `defectLocationId`). Phiếu nhập `WORKSHOP` chỉ sinh ra
từ `POST /production-requests/:id/receive`. Không gọi `allocateArrivals`.

### Kho hàng hỏng (D-4) – giữ nguyên

`POST/PATCH /warehouses` thêm `isSellable?: boolean` (false = kho hàng hỏng). `POST/PATCH /branches` và
`/warehouses` thêm `damagedLocationId?: string | null` – phải là location `isSellable = false` khác chính
nó, cùng tenant (`LOCATION_DAMAGED_INVALID`). Response chi nhánh / kho trả thêm `isSellable`,
`damagedLocationId`, `defaultFulfillmentLocationId`. Logic đặt trong `LocationService` (dùng chung).

## 4. Lấy hàng & giao hàng – Track C, A, E (BE `shipments/`)

Phần lớn là track **C** (C-2, C-3, C-5, C-7, C-8, C-9; C-4 Phase 2). Trong `deliver`, quy tắc trạng thái
sau khi giao là **A-10** và việc ghi `Payment` là **E-5**. Webhook Shopee là **E-8** (Phase 2). Phần
đóng đơn (C-1) và trừ kho (C-2) nằm ở §2 vì route thuộc `orders/`.

```ts
Shipment = {
  id, status: ShipmentStatus, carrierType: 'INTERNAL' | 'EXTERNAL', carrierName, trackingCode,
  order: { id, code, status, customerName, amountDue }, driver: UserRef | null,
  recipientName, recipientPhone, deliveryAddress, scheduledDate, scheduledSlot, deliveredAt,
  requiresInstallation, installedAt, proofPhotoUrls: string[], shippingCost, note, createdAt,
  events: { id, status, source: 'MANUAL' | 'CARRIER', note, latitude, longitude, createdBy: UserRef | null, occurredAt }[],
}
```

`INTERNAL` = shipper / thợ hợp đồng (có tài khoản, `driverId`). `EXTERNAL` = ĐVVC bên thứ ba *(tự
cập nhật qua webhook – sau; Phase 1 đánh tay)*.

| Route | Quyền | Body | Task (BE · FE) |
|---|---|---|---|
| `GET /shipments` | `shipments:read` | `page, limit, status, carrierType, driverId, from, to, search` | C-3 · C-9 |
| `GET /shipments/mine` | `shipments:deliver` | đơn cần giao của chính shipper (`driverId` = mình, chưa kết thúc), **kèm `order.amountDue`** | C-5 · C-7 |
| `GET /shipments/:id` | `shipments:read` hoặc là driver | | C-3 · C-9, C-7 |
| `POST /shipments` | `shipments:create` | `{ orderId, carrierType, carrierName?, trackingCode?, driverId?, scheduledDate?, scheduledSlot?, requiresInstallation?, shippingCost?, note? }` – **đây là bước "ĐVVC đã lấy hàng"**: đơn phải `PACKED` (`SHIPMENT_ORDER_NOT_PACKED`) → shipment `PICKED_UP`, đơn `PICKED_UP`. `INTERNAL` bắt buộc `driverId` (`SHIPMENT_DRIVER_REQUIRED`, gán shipper – C-8). Địa chỉ copy từ đơn. | C-2, C-8 · C-9 |
| `PATCH /shipments/:id/driver` | `shipments:update` | `{ driverId }` – đổi shipper / thợ của shipment `INTERNAL` chưa kết thúc; driver phải có quyền `shipments:deliver`; báo shipper mới | C-8 · C-9 |
| `POST /shipments/:id/events` | `shipments:update` | `{ status, note?, latitude?, longitude? }` – ghi nhật trình, không đổi trạng thái đơn | C-3 · C-9 |
| `POST /shipments/:id/deliver` | `shipments:deliver` (driver `INTERNAL`) hoặc `shipments:update` (`EXTERNAL`, đánh tay) | `DeliverDto` dưới. Đơn phải `SHIPPING` (`SHIPMENT_ORDER_NOT_SHIPPING`). | C-5 + A-10 (+ Payment E-5) · C-7, C-9 |
| `POST /shipments/:id/fail` | `shipments:update` hoặc driver | `{ note }` → `FAILED`; đơn giữ `SHIPPING` (hàng đã rời kho) – hàng quay về đi đường hoàn hàng `DELIVERY_FAILED` (§5) | C-3 · C-9 |
| `POST /webhook/carriers/:carrier` | `@Public()` + chữ ký | *(sau – ĐVVC / Shopee)* | C-4, E-8 (Phase 2) |

```ts
DeliverDto = {
  proofPhotoUrls: string[];             // INTERNAL: ≥ 1 → SHIPMENT_PROOF_REQUIRED
  paymentMethod: 'CASH' | 'BANK_TRANSFER_QR' | 'NONE';
  collectedAmount: number;              // phải = order.amountDue → ORDER_COLLECTION_AMOUNT_MISMATCH
  note?: string; latitude?: number; longitude?: number;
}
```

Kết quả `deliver` (trong một transaction, qua `assertTransition`; quy tắc trạng thái theo A-10):

| Điều kiện | Ghi `Payment` (E-5) | Đơn | `cashRemittanceStatus` |
|---|---|---|---|
| `amountDue = 0` (đã cọc 100%) – `paymentMethod` phải `NONE` | – | `COMPLETED` | `NOT_APPLICABLE` |
| `BANK_TRANSFER_QR` | `BALANCE`, `PAID`, `collectedBy` = driver | `COMPLETED` (có chờ webhook SePay không: **chờ chốt**, §8) | `NOT_APPLICABLE` |
| `CASH` | `BALANCE`, `PAID`, `collectedBy` = driver | `RECEIVED` | `PENDING` → chủ gọi `confirm-remittance` |

`amountDue > 0` mà gửi `NONE` → `ORDER_COLLECTION_AMOUNT_MISMATCH`. Dòng đơn không đổi (đã `SHIPPED`).
Thông báo người phụ trách + chủ khi đơn chờ nộp tiền (template mới trong `templates/order.templates.ts`).

Ảnh bằng chứng upload qua `POST /uploads` hiện có, gửi URL.

## 5. Hoàn hàng – Track D (BE `order-returns/`)

```ts
OrderReturn = {
  id, code /* DH-HOAN-000123 */, status: OrderReturnStatus, reason: 'CUSTOMER_RETURN' | 'DELIVERY_FAILED',
  order: { id, code, customerName, assigneeId }, shipmentId, note,
  replacementOrder: { id, code } | null,          // đơn mua lại (GĐ2 – 3B)
  createdBy: UserRef | null, inspectedBy: UserRef | null, inspectedAt, completedAt, createdAt,
  items: { id, orderItemId, productName, sku, quantity, condition: 'GOOD' | 'DAMAGED' | null,
           location: { id, name } | null, note }[],
}
```

`OrderReturnStatus`: `REQUESTED` (Yêu cầu hoàn) → `INSPECTING` (Đang kiểm tra hàng hoàn) →
`COMPLETED` (Hoàn tất xử lý), hoặc `CANCELLED`. "Đã tái nhập kho / Đã ghi nhận hàng hỏng" là kết quả
**theo từng dòng** (`condition`), không phải trạng thái của phiếu. Thay `PENDING`/`INSPECTED` hiện có.

| Route | Quyền | Body | Task (BE · FE) |
|---|---|---|---|
| `GET /order-returns` | `returns:read` | `page, limit, status, orderId, search` | D-5 · D-6 |
| `GET /order-returns/:id` | `returns:read` | | D-5 · D-6 |
| `POST /order-returns` | `returns:create` **hoặc** là người phụ trách đơn (`ORDER_RETURN_DENIED`) | `{ orderId, reason, shipmentId?, note?, items: [{ orderItemId, quantity, note? }] }` – đơn phải đã trừ kho (`SHIPPING` / `RECEIVED` / `COMPLETED`), khác → `ORDER_RETURN_ORDER_NOT_RETURNABLE`; vượt `quantity − returnedQuantity` → `ORDER_RETURN_QTY_EXCEEDS` → `REQUESTED` | D-5 · D-6 |
| `POST /order-returns/:id/receive` | `returns:inspect` | `{}` – hàng đã về tới shop: `REQUESTED` → `INSPECTING` | D-5 · D-6 |
| `POST /order-returns/:id/inspect` | `returns:inspect` | `{ items: [{ orderItemId, condition, locationId? }] }` – mọi dòng phải có `condition` (`ORDER_RETURN_CONDITION_REQUIRED`). `GOOD` → `returnDrawn` vào `locationId` (mặc định kho xuất, phải sellable), `RETURN_GOOD` – **cộng lại tồn kho**. `DAMAGED` → `returnDrawn` vào `damagedLocationId` của kho xuất (`LOCATION_DAMAGED_REQUIRED`), `RETURN_DAMAGED` – **không** vào tồn bán được. Cập nhật `returnedQuantity`, dòng `RETURNED` khi hoàn đủ, đơn `RETURNED` khi mọi dòng hoàn đủ. Phiếu → `COMPLETED`. | D-5 · D-6 |
| `POST /order-returns/:id/cancel` | `returns:cancel` | chỉ `REQUESTED` / `INSPECTING` (chưa đụng kho) | D-5 · D-6 |
| `PATCH /order-returns/:id/replacement-order` | `returns:create` | `{ orderId }` – gắn đơn mua lại. Đơn mua lại là **đơn tay mới** tạo bằng `POST /orders` (chạy lại từ GĐ1 – Bước 1); FE mở form tạo đơn điền sẵn khách + mặt hàng hỏng rồi gọi route này. | D-10 · D-11 |

`DELIVERY_FAILED`: hàng chưa tới tay khách nhưng đã trừ kho lúc `ship`, nên đi đúng đường này để trả kho.
Hoàn tiền (Payment REFUND) – sau (E-5). Đồng bộ yêu cầu hoàn từ Shopee – Phase 2 (E-9).

## 6. Phân quyền – việc phải làm ở `prisma/seed.ts` (P0-3)

Hành trình: "khó gắn vào quyền tổng thì tạo quyền riêng". Danh sách theo Notion P0-3. Thêm vào
`CATALOG` (rồi chạy `node scripts/check-permissions.js`):

| Cặp | Thao tác | Bước |
|---|---|---|
| `orders:create` *(có)* | Tạo đơn + chọn người phụ trách | GĐ1 – 1 |
| `orders:update` *(có)* | Sửa đơn, đổi người phụ trách / tag ưu tiên trước khi đi (A-8) | GĐ1 – 1, 3 |
| `orders:confirm` *(có)* | Xác nhận đơn Shopee *(sau)* | GĐ1 – 2 |
| `production_requests:create` / `update` / `delete` *(có)* | Lập, sửa, gửi, hủy yêu cầu sản xuất cho xưởng | GĐ1 – 4 |
| `production:receive` **(mới)** | Nhập số lượng hàng đã nhận từ xưởng / tổng đã đặt (tăng tồn kho) | GĐ1 – 4 |
| `orders:pack` **(mới)** | Đóng đơn (C-1). Quyền riêng chứ không dùng `orders:update`: người đóng gói ở kho không được sửa giá / món của đơn, và người bán hàng có `update` không tự đóng đơn được. Chốt 2026-10-04. | GĐ1 – 5 |
| `shipments:create` *(có)* | Ghi nhận ĐVVC đã lấy hàng | GĐ1 – 6 |
| `orders:ship` **(mới)** | Xác nhận chuyển Đang vận chuyển (trừ tồn kho) | GĐ1 – 6 |
| `shipments:deliver` *(có)* | Shipper xem đơn cần giao, xác nhận đã giao | GĐ1 – 6, 7 |
| `orders:confirm_cash` **(mới)** | Xác nhận đã nhận đủ tiền từ shipper | GĐ1 – 7 |
| `returns:create` / `returns:inspect` / `returns:cancel` *(có)* | Tạo và xử lý đơn hoàn | GĐ2 |

`orders:assign` và `fulfillments:*` không còn route nào dùng ở Phase 1 (để nguyên trong catalog, như
các cặp chưa dùng khác).

Mã lỗi mới cần thêm vào `error-codes.ts`: `ORDER_NOT_EDITABLE`, `ORDER_DEPOSIT_EXCEEDS_TOTAL`,
`ORDER_DEPOSIT_CHANGED`, `ORDER_SHIP_INSUFFICIENT_STOCK`, `ORDER_COLLECTION_AMOUNT_MISMATCH`,
`ORDER_REMITTANCE_AMOUNT_MISMATCH`, `ORDER_REMITTANCE_NOT_PENDING`, `IMPORT_WORKSHOP_VIA_PRODUCTION_REQUEST`,
`SHIPMENT_ORDER_NOT_PACKED`, `SHIPMENT_ORDER_NOT_SHIPPING`, `SHIPMENT_DRIVER_REQUIRED`.
Mã cũ không dùng nữa (`ORDER_NOT_DRAFT`, `RESERVATION_*`, `IMPORT_PRODUCTION_*`…) **giữ
nguyên** – danh sách là append-only.

**Schema (P0-8) – đã làm**, migration `20261004120000_order_journey_revision`:
- `Order`: `code` (unique theo tenant; đơn cũ lấy `paymentReference`, đơn mới sinh bằng
  `generateReference(ORDER)`), `priority` (`NORMAL | HIGH | URGENT`, mặc định `NORMAL`),
  `depositAmount` (đổi tên từ `depositRequired`) + `depositPercent` (CHECK `0 ≤ cọc ≤ grandTotal`,
  `0 < % ≤ 100`), `shippedById`, `shippedAt`. `amountDue` **không lưu**, tính `grandTotal − depositAmount`.
- Tiền thu khi giao và tiền shipper nộp lại **nằm ở `Payment`** (dòng `kind: BALANCE`), không lặp trên
  `Order`: thêm `remittanceStatus` (`NOT_APPLICABLE | PENDING | RECEIVED`), `remittanceConfirmedById`,
  `remittanceConfirmedAt`. `collection` của `OrderDetail` dựng từ dòng đó; filter `cashRemittanceStatus`
  của `GET /orders` lọc qua quan hệ `payments`.
- Trạng thái đơn / dòng / phiếu hoàn theo §2, §5; CHECK `orders_assignee_required` chỉ còn miễn
  `PENDING_CONFIRMATION`. Migration dừng nếu còn đơn ở `DRAFT` / `READY_TO_PACK` / `DELIVERED`.
- `OrderReturn`: `replacementOrderId`, `receivedById`, `receivedAt`, `completedAt`.
- Danh sách cần sản xuất **không có bảng** (tính lúc xem); đặt xưởng và nhận hàng dùng bảng YCSX
  (`ProductionRequest`, `ProductionRequestItem`) và phiếu nhập `WORKSHOP` đã có sẵn.
- **Không đổi:** `Shipment.fulfillmentId` vẫn bắt buộc – `pack` (C-1) tạo một `Fulfillment` trạng thái
  `PACKED` (kèm `FulfillmentItem`, `FulfillmentPackage`, `verifiedBy`), `POST /shipments` gắn vào đó.
  Bảng `stock_reservations` và cột `inventories.reserved` **đã xoá** (cùng migration).
- Hẹn giao dùng `requestedDeliveryDate` đã có.

`Payment.method` khi shipper thu bằng QR (`BANK_TRANSFER_QR`): **chờ chốt** `SEPAY` hay `BANK_TRANSFER`.

## 7. Rút khỏi Phase 1 (track nào đang làm dở thì dừng)

- **Giữ hàng (đã xoá khỏi schema và code):** `StockReservation`, `inventories.reserved`, `reserve` / `release` / `consume` / `allocateArrivals` trong `InventoryService`;
  `heldQuantity`, `OrderItemStatus.WAITING_STOCK/READY`, `OrderStatus.DRAFT/READY_TO_PACK/DELIVERED`, `asDraft`.
- **Route `/fulfillments/*` riêng – đã bỏ (2026-10-04)**: create / items / packages / verify / cancel và DTO của chúng đã xoá khỏi code; `FulfillmentController` chỉ còn khung trống. Đóng đơn đi qua `POST /orders/:id/pack` (vẫn tạo FulfillmentPackage, C-1). Hủy đơn đã đóng gói thuộc A-5 (`releaseLockedStock`).
- FE: `src/types/order-flow.ts`, `src/lib/api/order-journey.ts`, `src/lib/api/fulfillment.ts` viết
  theo bản cũ – sửa theo file này.

## 8. Điểm chưa chốt

Từ hành trình đơn hàng:
- **Hủy đơn:** được hủy ở trạng thái nào, xử lý tiền cọc (hoàn / giữ) – A-5 chưa làm tới khi chốt.
- **COD qua ĐVVC bên thứ ba:** `cashRemittanceStatus` hiện chỉ cho shipper / thợ hợp đồng; đối soát
  với ĐVVC chốt khi làm Shopee (E-8).

Từ Notion v2 (contract để chờ, không tự quyết):
- **Kho dùng để tính tồn** (B-2): theo `sourceLocationId` của dòng hay tổng các kho.
- **QR có cần đối soát không** (A-10, E-5): hành trình cho QR "chuyển thẳng Hoàn thành". Có muốn chờ
  webhook SePay báo tiền về rồi mới `COMPLETED` không.
- **`Payment.method` cho tiền QR shipper thu** (E-5): `SEPAY` hay `BANK_TRANSFER`.
- **Thiếu ở chi nhánh, đặt xưởng về kho** (B-4): danh sách tính thiếu theo `sourceLocationId` của dòng
  đơn, nên YCSX giao về kho không trừ vào số thiếu của chi nhánh. Chọn: (a) cộng cả YCSX về
  `defaultFulfillmentLocationId` của chi nhánh vào `onOrderQuantity`, hay (b) giữ như hiện tại (chi nhánh
  chỉ hết thiếu khi phiếu chuyển kho về tới).

Của riêng contract:
- **Lưu tình trạng tồn kho trên order item:** hành trình gợi ý lưu "tình trạng lúc kiểm tra". Contract
  này **tính lúc đọc** (`stockCheck`) vì không giữ hàng thì con số lưu lại sai ngay khi đơn khác ship.
  Cần ảnh chụp lịch sử thì thêm sau.
- **Sửa đơn sau khi đã cọc theo %** làm tiền cọc lệch số đã thu – xem `ORDER_DEPOSIT_CHANGED`.

## 9. Bảng đối chiếu Task Notion v2 ↔ hành trình ↔ contract

| Mã | Phần | Bước hành trình | Mục contract |
|---|---|---|---|
| P0-1 | BE | nền dữ liệu | §6 (migration gốc) |
| P0-2 | BE | toàn flow | §0, §2 trạng thái, §5 trạng thái |
| P0-3 | BE | bảng phân quyền | §6 |
| P0-4 | BE | khung module | – |
| P0-5 | BE | GĐ1–4, 6; GĐ2–3A | §1 |
| P0-6 | BE/FE/Docs | toàn flow | cả file |
| P0-7 | FE | menu | – |
| P0-8 | BE | GĐ1–1, 4, 6, 7 | §6 Schema |
| A-1 | BE | GĐ1–1→7, 3; GĐ2 | §2 `assertTransition` |
| A-2 | BE | GĐ1–1; GĐ2–3B | §2 `POST /orders`, `CreateOrderDto`, tiền cọc |
| A-3 | BE | GĐ1–2 (Phase 2) | §2 `POST /orders/:id/confirm` |
| A-4 | BE | GĐ1–1, 2 | §2 `PUT …/customization` |
| A-5 | BE | nhánh hủy GĐ1 | §2 `POST /orders/:id/cancel`, §8 |
| A-8 | BE | GĐ1–1→6, 3 | §2 `PATCH /orders/:id`, `/assignee`, `/priority` |
| A-9 | BE | GĐ1–3, 7; GĐ2 | §2 `GET /orders`, `GET /orders/:id` |
| A-10 | BE | GĐ1–7, 8 | §2 `confirm-remittance`, §4 kết quả `deliver` |
| B-1 | BE/FE | GĐ1–4 | §3 phiếu nhập NCC / xưởng |
| B-2 | BE | GĐ1–3 | §2 `StockCheck`, §3 cách tính |
| B-3 | BE | GĐ1–3, 4 | §3 cảnh báo thiếu hàng |
| B-4 | BE | GĐ1–4 | §3 `GET /production-list` |
| B-5 | BE | GĐ1–4 | §3 `receive`, `history`, phiếu nhập |
| B-6 | FE | GĐ1–4 | §3 `GET /production-list`, `history` |
| B-7 | FE | GĐ1–4 | §3 `receive`, phiếu nhập |
| C-1 | BE | GĐ1–5 | §2 `POST /orders/:id/pack` |
| C-2 | BE | GĐ1–6 | §4 `POST /shipments`, §2 `POST /orders/:id/ship` |
| C-3 | BE | GĐ1–6, 7 | §4 `GET /shipments*`, `events`, `fail` |
| C-4 | BE | GĐ1–6b (Phase 2) | §4 webhook |
| C-5 | BE | GĐ1–6a, 7 | §4 `mine`, `deliver` |
| C-6 | FE | GĐ1–5 | §2 `pack` |
| C-7 | FE | GĐ1–6a, 7 | §4 `mine`, `deliver` |
| C-8 | BE | GĐ1–6a | §4 `driverId` trong `POST /shipments`, `PATCH /shipments/:id/driver` |
| C-9 | FE | GĐ1–6 | §4, §2 `ship` |
| D-1 | FE | GĐ1–1→8; GĐ2 | §2 `GET /orders` |
| D-2 | FE | GĐ1–1; GĐ2–3B | §2 `POST /orders`, customization |
| D-3 | FE | GĐ1–2, 3, 7 | §2 `GET /orders/:id`, `confirm` |
| D-4 | FE | GĐ2–3B; GĐ1–4 | §3 kho hàng hỏng |
| D-5 | BE | GĐ2–1→3 | §5 |
| D-6 | FE | GĐ2–1, 2 | §5 |
| D-7 | FE | GĐ1–3 | §2 `PATCH /orders/:id`, `/assignee`, `/priority` |
| D-8 | FE | GĐ1–2 (Phase 2) | §2 customization |
| D-9 | FE | GĐ1–7 | §2 `confirm-remittance` |
| D-10 | BE | GĐ2–3B | §5 `replacement-order` |
| D-11 | FE | GĐ2–3B | §5 `replacement-order` |
| E-1 | BE | GĐ1–1 Shopee (Phase 2) | – |
| E-2 | BE | GĐ1–1 Shopee (Phase 2) | §2 `PENDING_CONFIRMATION` |
| E-3 | BE | hủy đơn Shopee (Phase 2) | – |
| E-4 | FE | GĐ1–1, 3 Shopee (Phase 2) | – |
| E-5 | BE | GĐ1–1, 7 | §2 tiền cọc, legacy; §4 `Payment` khi `deliver` |
| E-6 | FE | GĐ1–1, 7 | §2 `OrderDetail.deposit/collection`, legacy |
| E-7 | BE/FE | báo cáo | – |
| E-8 | BE | GĐ1–6b, 7 Shopee (Phase 2) | §4 webhook |
| E-9 | BE | GĐ2–1 Shopee (Phase 2) | §5 ghi chú |
| F-1 | BE | GĐ1–1→8; GĐ2 | cả file |
| F-2 | Docs | – | – |
| F-3 | BE/FE | theo track | cả file |
