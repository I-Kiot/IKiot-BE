# Contract API – Hành trình đơn hàng (Phase 1)

> Chốt ở Phase 0 (P0-6, 2026-10-02), **sửa lại 2026-10-04 theo biên bản họp 02/10/2026**.
> Luồng nghiệp vụ là nguồn gốc: [`hanh-trinh-don-hang.md`](../../docs/hanh-trinh-don-hang.md)
> (workspace). File này lệch với nó ở đâu thì file này sai. Cần đổi contract → nhắn Astersa,
> **không tự sửa route/field của track khác**. Task: Notion "Task – Hành trình đơn hàng".
>
> **Phase 1 = luồng tạo đơn bằng tay.** Phần Shopee (đơn `PENDING_CONFIRMATION`, xác nhận đơn
> sàn, ĐVVC bên thứ ba tự cập nhật) chỉ giữ chỗ, làm sau khi luồng tay chạy ổn với nhân viên khách.

## Những gì đổi so với bản 2026-10-02

| Bản cũ | Bản này | Vì sao (hành trình đơn hàng) |
|---|---|---|
| Xác nhận đơn **giữ hàng** (`reserve`), hàng về tự `allocateArrivals` | **Không giữ hàng ở bất kỳ bước nào.** `reserve` / `release` / `consume` / `allocateArrivals` không được gọi từ luồng đơn | "Không tự động trừ hay giữ tồn kho khi đơn chưa đi" |
| Trừ kho lúc **verify đóng hàng** (C-1) | Trừ kho lúc **chuyển sang Đang vận chuyển** (`POST /orders/:id/ship`), thiếu là chặn | GĐ1 – Bước 6 |
| Tạo đơn tay có `asDraft` → `DRAFT` | Bỏ `DRAFT`. Tạo đơn tay **luôn ra `CONFIRMED`**, bắt buộc người phụ trách | GĐ1 – Bước 1 |
| Trạng thái `READY_TO_PACK`, dòng `WAITING_STOCK`/`READY` theo hàng đã giữ | Bỏ. Tình trạng tồn kho của dòng là **thông tin để xem** (`stockCheck`), không phải trạng thái | GĐ1 – Bước 3 |
| — | Thêm **`PICKED_UP`** (ĐVVC đã lấy hàng) giữa Đóng đơn và Đang vận chuyển | Trạng thái chính |
| — | Thêm **tiền cọc** (số tiền hoặc %), **còn phải thu**, **theo dõi tiền mặt shipper nộp lại** | GĐ1 – Bước 1, 7 |
| — | Thêm **tag ưu tiên** trên đơn | GĐ1 – Bước 3 |
| YCSX gửi xưởng (supplier WORKSHOP, DRAFT → SENT → …), phiếu nhập WORKSHOP | **Danh sách cần sản xuất gộp theo mặt hàng** + ô nhập "đã sản xuất / tổng", nhập là tăng tồn kho | GĐ1 – Bước 4. Hệ thống không gửi xưởng |
| Fulfillment pick/pack/kiện/verify (Track C) | Đóng đơn là **một bước chuyển trạng thái** trên đơn | GĐ1 – Bước 5 |
| `OrderReturn` PENDING → INSPECTED | REQUESTED → INSPECTING → COMPLETED | GĐ2 |

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
| Trạng thái | Chỉ dùng hằng trong `src/common/constants/*-status.ts`, `inventory-ledger.ts` – không viết chuỗi tay |
| Cross-tenant | 404, không 403 |
| Quyền | Mỗi route ghi `@Permissions(resource, action)` như bảng dưới + `@ApiBearerAuth('bearer')`. Cặp đánh dấu **(mới)** chưa có trong seed – xem §6. |

**Location:** `Branch.id = Warehouse.id = Location.id`. Mọi field `locationId` / `sourceLocationId` /
`damagedLocationId` là id của Location (chi nhánh hay kho đều được, trừ chỗ ghi rõ).

## 1. Tồn kho – nguyên tắc và hàm dùng chung (`InventoryService`, chỉ gọi, không sửa)

**Nguyên tắc:** tồn kho chỉ đổi khi hàng thật sự di chuyển –
tăng khi **nhập hàng sản xuất** (§3) hoặc nhập NCC / hoàn hàng nguyên vẹn,
giảm khi đơn **chuyển sang Đang vận chuyển** (§2). Tạo, xác nhận, sửa, đóng đơn, hủy trước khi đi:
**không đụng tồn kho**. Stock = 0 vẫn tạo / xác nhận / gán người phụ trách / đóng đơn bình thường.

Hệ quả: `inventories.reserved` luôn = 0 với luồng đơn mới; "còn bán được" = `stock`. Nhiều đơn
cùng cần một mặt hàng là chuyện bình thường – **đơn nào đi trước do người dùng quyết** (tag ưu tiên,
ngày hẹn giao), hệ thống chỉ chặn ở cửa `ship`.

Tất cả nhận `tx` (Prisma transaction client) của caller. Bất biến: Σ `lot.remainingQuantity` = `inventories.stock`.

| Hàm | Dùng ở | Ghi chú |
|---|---|---|
| `deductStock(tx, { tenantId, locationId, productItemId, quantity, label, ledger })` | `POST /orders/:id/ship` | Trừ kho + rút lô FIFO trong cùng câu `UPDATE` có điều kiện. Luồng đơn gọi với `ledger: { type: SALE, referenceType: ORDER, referenceId: orderId, orderItemId, createdById }` – **bắt buộc có `orderItemId`** thì hoàn hàng mới tìm lại đúng lô. Thiếu → `INSUFFICIENT_STOCK`. |
| `openLot(tx, { tenantId, locationId, productItemId, quantity, unitCost?, sourceType, supplierId?, productionRequestItemId?, orderItemId?, ledger })` → `{ inventory, lotId }` | §3 nhập hàng sản xuất, nhập NCC | Hàng mới về. Hàng sản xuất: `sourceType: WORKSHOP`, `ledger.type: IMPORT`, `referenceType: PRODUCTION_REQUEST`. Dòng custom: truyền `orderItemId` để lô gắn với dòng đó. |
| `returnDrawn(tx, { tenantId, productItemId, toLocationId, quantity, drawnBy: { orderItemId }, ledger, ifNeverDrawn? })` | §5 hoàn hàng | Hàng quay lại đúng lô đã rút lúc `ship`. Nguyên vẹn: `RETURN_GOOD` vào kho bán; hỏng: `RETURN_DAMAGED` vào kho hỏng. |
| `lowStockCrossing` / `notifyLowStock` | như cũ | `notifyLowStock` gọi **sau commit**. |
| ~~`reserve` / `release` / `consume` / `allocateArrivals`~~ | — | **Luồng đơn không gọi.** Hàm còn trong code; không xoá ở đợt này để khỏi đụng track khác. |

**Giá vốn dòng hàng:** `OrderItem.unitCostPrice` trước đây do `consume` tính. Giờ `ship` tự tính
sau khi `deductStock`: Σ (|quantity| × `lot.unitCost`) của các dòng ledger SALE mang `orderItemId`
đó ÷ số lượng. **Chưa có hàm dùng chung cho việc này** – track A viết trong `orders/`.

Ledger: `type` ∈ `InventoryTxType`, `referenceType` ∈ `InventoryRefType` (`src/common/constants/inventory-ledger.ts`).

## 2. Đơn hàng – Track A (BE `orders/`), FE Track D (`sales/`)

### Trạng thái

```
PENDING_CONFIRMATION (chỉ Shopee – sau)
        │ POST /orders/:id/confirm
        ▼
CONFIRMED ──POST /orders/:id/pack──▶ PACKED ──POST /shipments──▶ PICKED_UP
(đơn tay tạo ra ở đây)               (Đóng đơn)                  (ĐVVC đã lấy hàng)
                                                                     │ POST /orders/:id/ship  ← trừ tồn kho, thiếu là chặn
                                                                     ▼
                                                                  SHIPPING ──deliver, tiền mặt──▶ DELIVERED ──confirm-remittance──▶ COMPLETED
                                                                     └──deliver, QR / không còn phải thu─────────────────────────▶ COMPLETED
```

| `OrderStatus` | Nhãn | Ghi chú |
|---|---|---|
| `PENDING_CONFIRMATION` | Chờ xác nhận | Chỉ đơn Shopee *(sau)*. Chưa có người phụ trách. |
| `CONFIRMED` | Xác nhận | Đơn tay sinh ra ở đây. Sửa được (`PATCH /orders/:id`). |
| `PACKED` | Đóng đơn | Đã đóng gói, chờ shipper / ĐVVC đến lấy. |
| `PICKED_UP` | Đơn vị vận chuyển đã lấy hàng | Có `Shipment`. Chưa trừ kho. |
| `SHIPPING` | Đang vận chuyển | **Tồn kho đã trừ.** |
| `DELIVERED` | Đã nhận hàng | Chỉ khi shipper thu **tiền mặt**: chờ chủ xác nhận đã nhận đủ tiền. |
| `COMPLETED` | Hoàn thành | Kết thúc GĐ1. Hoàn hàng (GĐ2) mở từ đây. |
| `CANCELLED` | Đã hủy | **Chưa chốt** – xem `POST /orders/:id/cancel`. |
| `RETURNED` | Đã hoàn | Mọi dòng đã hoàn đủ (§5). |

Bỏ khỏi `OrderStatus`: `DRAFT`, `READY_TO_PACK` (và `PENDING` legacy khi A-2 xong). Thêm `PICKED_UP`.
`OrderItemStatus` rút về `PENDING | SHIPPED | RETURNED | CANCELLED` – dòng không còn trạng thái theo
hàng đã giữ. `deriveOrderStatus` / `deriveLineStatus` (`src/modules/orders/order-status.ts`) bỏ;
trạng thái đơn đổi bằng **một hàm chuyển trạng thái** `assertTransition(from, to)` trong cùng file,
mọi route bên dưới đi qua nó (sai bước → `ORDER_STATUS_TRANSITION_INVALID`).

### Kiểu trả về

```ts
OrderDetail = {
  id, code: string, status: OrderStatus, channel: 'MANUAL' | 'SHOPEE',
  priority: OrderPriority,            // 'NORMAL' | 'HIGH' | 'URGENT' – tag ưu tiên
  branch: { id, name }, customer: { id, name, phone }, assignee: UserRef | null,
  createdBy: UserRef | null, confirmedBy: UserRef | null, confirmedAt: string | null,
  shippedBy: UserRef | null, shippedAt: string | null,   // người xác nhận Đang vận chuyển (trừ kho)
  fulfillmentType: 'STORE_PICKUP' | 'HOME_DELIVERY',
  subtotal, shippingFee, vatTotal, discountType, discountValue, grandTotal,
  deposit: { amount: number, percent: number | null } | null,  // percent = null khi nhập theo số tiền
  amountDue,                          // = grandTotal − deposit.amount; số shipper thu khi giao
  collection: {                       // null tới khi giao
    method: 'CASH' | 'BANK_TRANSFER_QR' | 'NONE', amount, collectedBy: UserRef | null, collectedAt,
    cashRemittanceStatus: 'NOT_APPLICABLE' | 'PENDING' | 'RECEIVED',  // tiền mặt shipper đã nộp lại chưa
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
StockCheck = {                        // tính lúc đọc, KHÔNG phải số đã giữ cho đơn này
  status: 'ENOUGH' | 'PARTIAL' | 'OUT_OF_STOCK',   // Đủ hàng / Thiếu một phần / Hết hàng
  stock, shortQuantity,               // shortQuantity = max(0, quantity − stock) tại sourceLocation
}
OrderItemCustomization = { lengthCm, widthCm, heightCm, material, color, fabricCode, note, attachmentUrls: string[],
  specs: { name, value, unit? }[] }
UserRef = { id, name, phoneNumber }
```

`OrderListItem` = `OrderDetail` bỏ `items/shipments/returns`, thêm `itemCount` và
`stockSummary: 'ENOUGH' | 'PARTIAL' | 'OUT_OF_STOCK' | null` (dòng tệ nhất; null khi đã ship) –
để danh sách lọc được "đơn đi được ngay".

`stockCheck` so **từng dòng riêng với tồn kho**, không trừ cho các đơn khác: hai đơn cùng cần 1 cái
tủ và kho còn 1 thì cả hai đều hiện "Đủ hàng". Đó là đúng ý hành trình (người dùng chọn đơn đi
trước); con số tổng thiếu của cả cửa hàng nằm ở danh sách cần sản xuất (§3).

### Route

| Route | Quyền | Body / query | Task |
|---|---|---|---|
| `GET /orders` | `orders:read` (+`view_all` để xem mọi chi nhánh) | `page, limit, search` (mã đơn, tên/SĐT khách), `status`, `channel`, `assigneeId`, `branchId`, `priority`, `stockSummary`, `cashRemittanceStatus`, `from`, `to`, `sort` (`createdAt` \| `requestedDeliveryDate` \| `priority`) | D-1 |
| `GET /orders/:id` | `orders:read` | → `OrderDetail` | D-3 |
| `POST /orders` | `orders:create` | `CreateOrderDto` dưới → đơn **`CONFIRMED`**, `confirmedBy` = người tạo. Không giữ hàng, không chặn vì tồn kho. | A-2 |
| `PATCH /orders/:id` | `orders:update` | Cùng field với create. Chỉ khi `CONFIRMED` → khác: `ORDER_NOT_EDITABLE`. Đổi item / giảm giá / phí ship thì tính lại `grandTotal`, `deposit.amount` (nếu cọc theo %) và `amountDue`. | A-2 |
| `PATCH /orders/:id/assignee` | `orders:assign` | `{ assigneeId }` – mọi trạng thái trước `COMPLETED` | A-3 |
| `PATCH /orders/:id/priority` | `orders:update` | `{ priority }` – mọi trạng thái trước `SHIPPING` (không cần mở form sửa đơn) | A-3 |
| `PUT /orders/:id/items/:itemId/customization` | `orders:update` | `OrderItemCustomization`. Lần đầu: tạo ProductItem mới cùng sản phẩm, chuyển dòng sang, `isCustom = true`. Chỉ khi `CONFIRMED`; khoá khi dòng đã có số **đã sản xuất > 0** (§3) → `ORDER_ITEM_CUSTOM_LOCKED`. | A-4 |
| `POST /orders/:id/pack` | `orders:pack` **(mới)** | `{ note? }` – `CONFIRMED` → `PACKED`. Không kiểm tồn kho; response kèm `stockCheck` để FE cảnh báo nếu đang thiếu. | A-5 |
| `POST /orders/:id/ship` | `orders:ship` **(mới)** | `{ note? }` – `PICKED_UP` → `SHIPPING`. Trong **một transaction**: khoá các dòng `inventories` liên quan, gom **mọi** dòng thiếu rồi mới báo (không dừng ở dòng đầu) → `ORDER_SHIP_INSUFFICIENT_STOCK` (409) với `errors: [{ orderItemId, sku, productName, locationId, locationName, required, stock, shortQuantity }]`; đủ hết thì `deductStock` từng dòng `STOCKED_LINE_TYPES` tại `sourceLocationId` (combo trừ từng dòng con), dòng → `SHIPPED`, ghi `unitCostPrice`, `shippedBy/At`, shipment đang mở `PICKED_UP` → `IN_TRANSIT`. `notifyLowStock` sau commit. | A-6 |
| `POST /orders/:id/confirm-remittance` | `orders:confirm_remittance` **(mới)** | `{ amount, note? }` – `DELIVERED` + `cashRemittanceStatus = PENDING` → `RECEIVED`, đơn `COMPLETED`. `amount` ≠ số shipper đã thu → `ORDER_REMITTANCE_AMOUNT_MISMATCH` (chủ phải nhận **đủ**). | A-7 |
| `POST /orders/:id/confirm` | `orders:confirm` | *(Shopee – sau)* `{ assigneeId, lines?: [{ orderItemId, sourceLocationId?, customization? }] }` – `PENDING_CONFIRMATION` → `CONFIRMED`. Không giữ hàng. | – |
| `POST /orders/:id/cancel` | `orders:update` | `{ reason? }` – **chưa chốt** (xem §8). Tạm thời: cho phép `CONFIRMED` / `PACKED` / `PICKED_UP` (chưa trừ kho → không có gì để trả lại; shipment đang mở → `CANCELLED`); từ `SHIPPING` trở đi → `ORDER_CANCEL_NOT_ALLOWED` (đi đường hoàn hàng). Tiền cọc: **chưa xử lý**, chỉ giữ nguyên trên đơn. | A-5 |
| `PATCH /orders/:id/status`, `POST /orders/:id/pay-offline` | như cũ | **Legacy** (POS cũ, bán tại quầy) – giữ tới khi E-5 thay. | – |

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
  recipientName?: string; recipientPhone?: string; deliveryAddress?: string; requestedDeliveryDate?: string;
  note?: string;
}
```

**Tiền cọc** (chỉ đơn tay):
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

`fulfillmentType: TAKEAWAY` (bán tại quầy) không thuộc hành trình này – vẫn đi POS legacy.

## 3. Danh sách cần sản xuất & nhập hàng sản xuất – Track B

Hệ thống **chỉ lập danh sách** để staff liên hệ bên sản xuất; không gửi xưởng, không tự sản xuất.

### Cách tính

Một dòng = một cặp **(location, productItemId)**. Dòng custom có ProductItem riêng (A-4) nên tự nhiên
thành dòng riêng, mang theo thông số thiết kế.

- `demandQuantity` = Σ `quantity` của các dòng có tồn kho (`STOCKED_LINE_TYPES`) thuộc đơn
  `CONFIRMED` / `PACKED` / `PICKED_UP` (chưa ship) có `sourceLocationId` = location.
- `shortQuantity` = `max(0, demandQuantity − stock)`.
- `producedQuantity` = số đã nhập sản xuất trong **đợt đang mở** của dòng (lưu, xem dưới).
- `totalQuantity` = `producedQuantity + shortQuantity` → hiển thị **"producedQuantity / totalQuantity"**.

Nhập sản xuất tăng `stock` đúng bằng số vừa nhập nên `shortQuantity` giảm đúng bằng chừng đó và
`totalQuantity` giữ nguyên – ô "đã sản xuất / tổng" chạy đúng mà không phải chốt số tổng lúc nào.
Đơn mới đến thì tổng tăng; ship đơn thì `demand` và `stock` cùng giảm nên tổng không đổi.

**Đợt sản xuất** lưu ở `ProductionRequestItem` (tận dụng bảng sẵn có, không thêm bảng): mỗi
(tenant, location, productItemId) có tối đa **một** dòng `OPEN`, `receivedQuantity` = `producedQuantity`.
Mở khi lần nhập đầu tiên; đóng (`COMPLETED`) khi sau một lần nhập `shortQuantity` về 0. Cần partial
unique index `WHERE status = 'OPEN'` – migration mới.

```ts
ProductionListRow = {
  location: { id, name }, productItemId, sku, productName, variantLabel,
  isCustom, customization: OrderItemCustomization | null,
  stock, demandQuantity, shortQuantity, producedQuantity, totalQuantity,
  orders: { orderId, orderCode, orderItemId, quantity, priority, requestedDeliveryDate,
            assignee: UserRef | null, status: OrderStatus }[],   // sắp: priority giảm dần, rồi requestedDeliveryDate
}
```

### Route

| Route | Quyền | Body / query | Task |
|---|---|---|---|
| `GET /production-list` | `production_requests:read` | `locationId?`, `search?` (SKU, tên), `includeSatisfied?` (mặc định chỉ dòng `totalQuantity > 0`) → `ProductionListRow[]` | B-2 |
| `POST /production-list/receive` | `production_requests:receive` **(mới)** | `{ locationId, productItemId, quantity, receiveLocationId?, unitCost?, note? }` – `receiveLocationId` = kho / cửa hàng nhận hàng, mặc định `locationId`, phải sellable (`LOCATION_NOT_SELLABLE`). `openLot(sourceType: WORKSHOP, productionRequestItemId, orderItemId nếu dòng custom)`, cộng `receivedQuantity`, đóng đợt nếu hết thiếu. `quantity > shortQuantity` → `PRODUCTION_QTY_EXCEEDS_SHORTAGE` (nhập dư thì đi phiếu nhập kho thường). → `ProductionListRow` sau khi nhập. | B-5 |
| `GET /production-list/history` | `production_requests:read` | `locationId?, productItemId?, from?, to?, page, limit` – các lần nhập (ai, lúc nào, bao nhiêu, vào đâu), đọc từ ledger `referenceType = PRODUCTION_REQUEST` | B-6 |

Nhận vào **location khác** dòng đang thiếu (`receiveLocationId ≠ locationId`) vẫn ghi vào đợt của
dòng đó nhưng **không làm giảm** `shortQuantity` của nó – phải chuyển kho tiếp. FE nên cảnh báo.

Cảnh báo thiếu hàng (B-3) giữ như cũ: `NotificationService` + template
`src/modules/notifications/templates/production-request.templates.ts`, `referenceId` = `productItemId`,
`link` = `/exchange/production-list?locationId=…&productItemId=…`. Bắn khi tạo / sửa đơn làm một dòng
chuyển từ `shortQuantity = 0` sang `> 0` (edge-triggered như `crossedLowStock`).

### Kho hàng hỏng (D-4) – giữ nguyên

`POST/PATCH /warehouses` thêm `isSellable?: boolean` (false = kho hàng hỏng). `POST/PATCH /branches` và
`/warehouses` thêm `damagedLocationId?: string | null` – phải là location `isSellable = false` khác chính
nó, cùng tenant (`LOCATION_DAMAGED_INVALID`). Response chi nhánh / kho trả thêm `isSellable`,
`damagedLocationId`, `defaultFulfillmentLocationId`. Logic đặt trong `LocationService` (dùng chung).

## 4. Lấy hàng & giao hàng – Track C (`shipments/`)

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

| Route | Quyền | Body | Task |
|---|---|---|---|
| `GET /shipments` | `shipments:read` | `page, limit, status, carrierType, driverId, from, to, search` | C-3 |
| `GET /shipments/mine` | `shipments:deliver` | đơn cần giao của chính shipper (`driverId` = mình, chưa kết thúc), **kèm `order.amountDue`** | C-5 |
| `GET /shipments/:id` | `shipments:read` hoặc là driver | | C-3 |
| `POST /shipments` | `shipments:create` | `{ orderId, carrierType, carrierName?, trackingCode?, driverId?, scheduledDate?, scheduledSlot?, requiresInstallation?, shippingCost?, note? }` – **đây là bước "ĐVVC đã lấy hàng"**: đơn phải `PACKED` (`SHIPMENT_ORDER_NOT_PACKED`) → shipment `PICKED_UP`, đơn `PICKED_UP`. `INTERNAL` bắt buộc `driverId` (`SHIPMENT_DRIVER_REQUIRED`). Địa chỉ copy từ đơn. | C-1 |
| `POST /shipments/:id/events` | `shipments:update` | `{ status, note?, latitude?, longitude? }` – ghi nhật trình, không đổi trạng thái đơn | C-3 |
| `POST /shipments/:id/deliver` | `shipments:deliver` (driver `INTERNAL`) hoặc `shipments:update` (`EXTERNAL`, đánh tay) | `DeliverDto` dưới. Đơn phải `SHIPPING` (`SHIPMENT_ORDER_NOT_SHIPPING`). | C-2 |
| `POST /shipments/:id/fail` | `shipments:update` hoặc driver | `{ note }` → `FAILED`; đơn giữ `SHIPPING` (hàng đã rời kho) – hàng quay về đi đường hoàn hàng `DELIVERY_FAILED` (§5) | C-3 |
| `POST /webhook/carriers/:carrier` | `@Public()` + chữ ký | *(sau – Shopee / ĐVVC)* | – |

```ts
DeliverDto = {
  proofPhotoUrls: string[];             // INTERNAL: ≥ 1 → SHIPMENT_PROOF_REQUIRED
  paymentMethod: 'CASH' | 'BANK_TRANSFER_QR' | 'NONE';
  collectedAmount: number;              // phải = order.amountDue → ORDER_COLLECTION_AMOUNT_MISMATCH
  note?: string; latitude?: number; longitude?: number;
}
```

Kết quả `deliver` (trong một transaction, qua `assertTransition`):

| Điều kiện | Ghi `Payment` | Đơn | `cashRemittanceStatus` |
|---|---|---|---|
| `amountDue = 0` (đã cọc 100%) – `paymentMethod` phải `NONE` | – | `COMPLETED` | `NOT_APPLICABLE` |
| `BANK_TRANSFER_QR` | `BALANCE`, `PAID`, `collectedBy` = driver | `COMPLETED` | `NOT_APPLICABLE` |
| `CASH` | `BALANCE`, `PAID`, `collectedBy` = driver | `DELIVERED` | `PENDING` → chủ gọi `confirm-remittance` |

`amountDue > 0` mà gửi `NONE` → `ORDER_COLLECTION_AMOUNT_MISMATCH`. Dòng đơn không đổi (đã `SHIPPED`).
Thông báo người phụ trách + chủ khi đơn chờ nộp tiền (template mới trong `templates/order.templates.ts`).

Ảnh bằng chứng upload qua `POST /uploads` hiện có, gửi URL.

## 5. Hoàn hàng – Track D (`order-returns/`)

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

| Route | Quyền | Body | Task |
|---|---|---|---|
| `GET /order-returns` | `returns:read` | `page, limit, status, orderId, search` | D-6 |
| `GET /order-returns/:id` | `returns:read` | | D-6 |
| `POST /order-returns` | `returns:create` **hoặc** là người phụ trách đơn (`ORDER_RETURN_DENIED`) | `{ orderId, reason, shipmentId?, note?, items: [{ orderItemId, quantity, note? }] }` – đơn phải đã trừ kho (`SHIPPING` / `DELIVERED` / `COMPLETED`), khác → `ORDER_RETURN_ORDER_NOT_RETURNABLE`; vượt `quantity − returnedQuantity` → `ORDER_RETURN_QTY_EXCEEDS` → `REQUESTED` | D-5 |
| `POST /order-returns/:id/receive` | `returns:inspect` | `{}` – hàng đã về tới shop: `REQUESTED` → `INSPECTING` | D-5 |
| `POST /order-returns/:id/inspect` | `returns:inspect` | `{ items: [{ orderItemId, condition, locationId? }] }` – mọi dòng phải có `condition` (`ORDER_RETURN_CONDITION_REQUIRED`). `GOOD` → `returnDrawn` vào `locationId` (mặc định kho xuất, phải sellable), `RETURN_GOOD` – **cộng lại tồn kho**. `DAMAGED` → `returnDrawn` vào `damagedLocationId` của kho xuất (`LOCATION_DAMAGED_REQUIRED`), `RETURN_DAMAGED` – **không** vào tồn bán được. Cập nhật `returnedQuantity`, dòng `RETURNED` khi hoàn đủ, đơn `RETURNED` khi mọi dòng hoàn đủ. Phiếu → `COMPLETED`. | D-5 |
| `POST /order-returns/:id/cancel` | `returns:cancel` | chỉ `REQUESTED` / `INSPECTING` (chưa đụng kho) | D-5 |
| `PATCH /order-returns/:id/replacement-order` | `returns:create` | `{ orderId }` – gắn đơn mua lại. Đơn mua lại là **đơn tay mới** tạo bằng `POST /orders` (chạy lại từ GĐ1 – Bước 1); FE mở form tạo đơn điền sẵn khách + mặt hàng hỏng rồi gọi route này. | D-7 |

`DELIVERY_FAILED`: hàng chưa tới tay khách nhưng đã trừ kho lúc `ship`, nên đi đúng đường này để trả kho.
Hoàn tiền (Payment REFUND) – Phase 2 (E-5).

## 6. Phân quyền – việc phải làm ở `prisma/seed.ts`

Hành trình: "khó gắn vào quyền tổng thì tạo quyền riêng". Thêm vào `CATALOG` (rồi chạy
`node scripts/check-permissions.js`):

| Cặp | Thao tác | Bước |
|---|---|---|
| `orders:create` *(có)* | Tạo đơn + chọn người phụ trách | GĐ1 – 1 |
| `orders:assign` *(có)* | Đổi người phụ trách | GĐ1 – 1 |
| `orders:confirm` *(có)* | Xác nhận đơn Shopee *(sau)* | GĐ1 – 2 |
| `production_requests:receive` **(mới)** | Nhập số lượng đã sản xuất (tăng tồn kho) | GĐ1 – 4 |
| `orders:pack` **(mới)** | Đóng đơn | GĐ1 – 5 |
| `shipments:create` *(có)* | Ghi nhận ĐVVC đã lấy hàng | GĐ1 – 6 |
| `orders:ship` **(mới)** | Xác nhận chuyển Đang vận chuyển (trừ tồn kho) | GĐ1 – 6 |
| `shipments:deliver` *(có)* | Shipper xem đơn cần giao, xác nhận đã giao | GĐ1 – 6, 7 |
| `orders:confirm_remittance` **(mới)** | Xác nhận đã nhận đủ tiền từ shipper | GĐ1 – 7 |
| `returns:create` / `returns:inspect` / `returns:cancel` *(có)* | Tạo và xử lý đơn hoàn | GĐ2 |

`fulfillments:*` không còn route nào dùng ở Phase 1 (để nguyên trong catalog, như các cặp chưa dùng khác).

Mã lỗi mới cần thêm vào `error-codes.ts`: `ORDER_NOT_EDITABLE`, `ORDER_DEPOSIT_EXCEEDS_TOTAL`,
`ORDER_DEPOSIT_CHANGED`, `ORDER_SHIP_INSUFFICIENT_STOCK`, `ORDER_COLLECTION_AMOUNT_MISMATCH`,
`ORDER_REMITTANCE_AMOUNT_MISMATCH`, `ORDER_REMITTANCE_NOT_PENDING`, `PRODUCTION_QTY_EXCEEDS_SHORTAGE`,
`SHIPMENT_ORDER_NOT_PACKED`, `SHIPMENT_ORDER_NOT_SHIPPING`, `SHIPMENT_DRIVER_REQUIRED`.
Mã cũ không dùng nữa (`ORDER_NOT_DRAFT`, `FULFILLMENT_*`, `RESERVATION_*`, `IMPORT_PRODUCTION_*`…) **giữ
nguyên** – danh sách là append-only.

Schema cần migration: `Order.priority`, `depositAmount` (đổi tên/ý nghĩa `depositRequired`),
`depositPercent`, `shippedById`, `shippedAt`, `cashRemittanceStatus`, `remittanceConfirmedById`,
`remittanceConfirmedAt`; `OrderReturn.replacementOrderId`, `completedAt`; partial unique index một đợt
`OPEN` trên `production_request_items`; bỏ `DRAFT` / `READY_TO_PACK` khỏi CHECK
`orders_assignee_required` và các comment trạng thái.

## 7. Rút khỏi Phase 1 (track nào đang làm dở thì dừng)

- **Giữ hàng:** `StockReservation`, `reserve` / `release` / `consume` / `allocateArrivals` trong luồng
  đơn; `heldQuantity`, `OrderItemStatus.WAITING_STOCK/READY`, `OrderStatus.DRAFT/READY_TO_PACK`, `asDraft`.
- **Fulfillment pick/pack** (`/fulfillments/*`, kiện hàng, verify): đóng đơn là `POST /orders/:id/pack`.
- **YCSX gửi xưởng** (`/production-requests` CRUD, `SENT`, `Supplier.type = WORKSHOP`), **phiếu nhập
  WORKSHOP** (`importSource`, `productionRequestItemId` trên `/stock-movements`): thay bằng §3.
  Phiếu nhập NCC thường và phần hàng lỗi (`defectQuantity` / `defectLocationId`) không thuộc hành trình
  này – giữ nếu track đã làm, nhưng **không** gọi `allocateArrivals`.
- FE: `src/types/order-flow.ts`, `src/lib/api/order-journey.ts`, `src/lib/api/fulfillment.ts` viết
  theo bản cũ – sửa theo file này.

## 8. Điểm chưa chốt (từ hành trình đơn hàng)

- **Hủy đơn:** được hủy ở trạng thái nào, xử lý tiền cọc (hoàn / giữ). Route ở §2 chỉ là tạm.
- **COD qua ĐVVC bên thứ ba:** `cashRemittanceStatus` hiện chỉ cho shipper / thợ hợp đồng; đối soát
  với ĐVVC chốt khi làm Shopee.
- **QR có cần đối soát không:** hành trình cho QR "chuyển thẳng Hoàn thành" theo xác nhận của shipper.
  Có muốn chờ webhook SePay báo tiền về rồi mới `COMPLETED` không – chưa hỏi.
- **Lưu tình trạng tồn kho trên order item:** hành trình gợi ý lưu "tình trạng lúc kiểm tra". Contract
  này **tính lúc đọc** (`stockCheck`) vì không giữ hàng thì con số lưu lại sai ngay khi đơn khác ship.
  Cần ảnh chụp lịch sử thì thêm sau.
- **Sửa đơn sau khi đã cọc theo %** làm tiền cọc lệch số đã thu – xem `ORDER_DEPOSIT_CHANGED`.
