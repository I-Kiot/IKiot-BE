# HANDOFF

Nhật ký bàn giao (tiếng Việt, chỉ thêm mục mới, không sửa các mục cũ).

## 2026-10-10 - Hoá đơn (invoices) theo vòng đời đơn hàng

**Đã làm**
- Migration `20261010100000_invoices_per_order`: `invoices.invoice_number` cho phép NULL, mặc định trạng thái `PENDING`, index duy nhất từng phần "mỗi đơn một hoá đơn SALE còn hiệu lực", backfill (đơn COMPLETED -> ISSUED, đơn đang xử lý -> PENDING).
- Module `invoices`: `GET /invoices` (lọc `kind=COUNTER|ORDERED`, `status`, `type`, `search`, ngày, `branchId`), `GET /invoices/:id`. Quyền `orders:read`. Chỉ đọc.
- `InvoiceService` gắn vào mọi chỗ đổi trạng thái đơn: tạo đơn POS và đơn tay (PENDING), COMPLETED (ISSUED), hủy (CANCELLED khi còn PENDING), trả hàng (hoá đơn điều chỉnh âm), webhook SePay.
- FE: `/sales/invoices` đọc từ `GET /invoices`, hai tab Bán tại quầy / Đơn hàng đặt, trạng thái hoá đơn Chờ xuất / Đã xuất / Đã hủy.

**Quyết định (đã chốt với chủ dự án)**
- ISSUED chỉ khi đơn COMPLETED (không phải PACKED/RECEIVED: giao đã thanh toán trước/QR đi thẳng SHIPPING -> COMPLETED).
- POS vẫn tạo Order (`fulfillmentType = TAKEAWAY`), COMPLETED ngay khi thu tiền xong; chuyển khoản SePay chỉ ISSUED khi webhook xác nhận tiền về.
- `STORE_PICKUP` tạm theo luồng chung.

**Chưa kiểm chứng / còn lại**
- Migration CHƯA áp vào `ikiot_db` (DB dev của chủ dự án); đã chạy thành công trên `ikiot_e2e`. Chạy `pnpm run deploy:migrate` khi sẵn sàng. Lưu ý: một lần chạy nhầm vào `ikiot_db` đã được hoàn tác thủ công và đánh dấu `rolled-back`.
- `GET /invoices` chưa có test HTTP thật (chỉ gọi qua service trong e2e). FE chưa mở trên trình duyệt.
- Panel mở rộng của hoá đơn chưa hiện cọc/giao hàng/người nhận cho đơn đặt; chưa có in/xuất hoá đơn VAT điện tử.
- Hoá đơn của đơn có chỉnh sửa/giảm giá cả đơn sau khi đã PENDING lấy số liệu tại lúc ISSUED (không chụp lại lúc tạo).

## 2026-10-16 - "Bắt đầu vận chuyển" chỉ cho người giữ quyền + mô tả quyền

**Đã làm**
- Bước PICKED_UP → SHIPPING (`POST /orders/:id/ship`, trừ tồn kho + gỡ hàng đang giữ) không còn miễn cho người phụ trách đơn: chỉ chủ shop, hoặc người giữ `orders:ship` đang được phân công tại kho xuất. Cờ `ASSIGNEE_MAY_SHIP = false` trong `src/modules/orders/order-handler.ts` (mỗi bước trong `OrderStepPermission` có `assigneeAllowed`); các bước khác (đóng gói, giao ĐVVC, đổi shipper, nhật trình) giữ nguyên. Chờ khách xác nhận - đồng ý thì bật `true` ở BE và cùng tên ở FE (`order-journey-actions.tsx`).
- Migration `20261016090000_permission_catalog_description`: thêm `permission_catalog.description` (mã `resource:action` không đổi vì `role_permissions` trỏ vào). Seed `CATALOG` nhận `descriptions` theo action; hiện chỉ có `orders:ship`. Migration cũng UPDATE sẵn mô tả này cho DB đã seed.
- FE: màn Vai trò hiện tên "Bắt đầu vận chuyển (trừ tồn kho)" + mô tả cả hàng dưới ô chọn, ô tìm khớp cả mô tả; trang đơn ẩn nút với người phụ trách không có quyền và hiện badge "Chờ người có quyền … xác nhận".
- Test: unit 348/348; e2e `order-ship` + `order-journey` 62/62 (case "người phụ trách ship không cần quyền" đổi thành bị từ chối `ORDER_STEP_DENIED`).

**Chưa kiểm chứng / còn lại**
- Chưa chạy toàn bộ e2e, chưa mở màn Vai trò / trang đơn trên trình duyệt.
- Dev/prod cần `migrate deploy` (dev CI tự chạy) - mô tả có ngay nhờ câu UPDATE, không cần seed lại.

## 2026-10-16 - Thuộc tính gắn vào sản phẩm, YCSX đổi thuộc tính / ảnh, làm riêng theo thuộc tính

**Đã làm**
- Migration `20261016100000_product_attributes`: bảng `product_attributes` (tên, đơn vị, thứ tự) gắn vào Product; `product_item_details.attribute_id` trỏ về đó (giá trị theo SKU). Backfill từ tên thuộc tính cũ trên các SKU (bỏ qua SKU custom sinh từ dòng đơn), rồi tách đơn vị gõ lẫn vào giá trị ("140×70×75 cm" → giá trị "140×70×75", đơn vị "cm") khi mọi giá trị của thuộc tính cùng đơn vị.
- Migration `20261016100100_order_spec_attributes_production_attachments`: `order_item_specs.attribute_id` + `base_value` (thay đổi theo đơn trỏ vào thuộc tính, chụp giá trị gốc); `production_request_items.attachment_urls` (ảnh gửi xưởng).
- Products: `attributes` trên tạo / sửa sản phẩm (sửa = thay cả danh sách, đổi tên giữ giá trị); `POST /products/:id/attributes` (products:update) cho nút "Thêm thuộc tính"; mọi giá trị SKU ghi qua `writeItemDetails` (`product-attributes.ts`).
- `ProductVariantService`: dòng YCSX hàng tồn có `attributeValues` → dùng SKU anh em đúng bộ thuộc tính hoặc tạo SKU `<sku>-V<n>` sao chép SKU gốc; `retailPrice` (chỉ khi tick "cập nhật giá") áp vào SKU kết quả. Tạo SKU cần products:create, đổi giá cần products:update. Dòng làm cho đơn không đổi được (`PRODUCTION_REQUEST_LINE_FIXED_BY_ORDER`). So khớp NFC + không phân biệt hoa thường.
- Làm riêng theo đơn: spec có `attributeId` ghi thành giá trị thuộc tính của SKU custom (giữ liên kết); ô cố định cũ vẫn đọc được.
- Response YCSX: mỗi dòng có `productId`, `retailPrice`, `attributes`, `attachmentUrls`, và `orderItem.customization` (thay đổi của khách, ghi chú, ảnh).
- Mã lỗi mới: PRODUCT_ATTRIBUTE_DUPLICATE / _NOT_FOUND / _VALUE_REQUIRED, PRODUCTION_REQUEST_LINE_FIXED_BY_ORDER.
- Test: unit 351/351 (thêm `product-attributes.spec.ts`), e2e toàn bộ 270/270 (thêm 4 case đổi thuộc tính trong `production-requests.e2e-spec.ts`).

**Chưa kiểm chứng / còn lại**
- Tải ảnh thật lên Cloudinary chưa thử (local trỏ vào tài khoản thật) - chỉ thử lưu / hiển thị bằng URL mẫu.
- Dev/prod cần `migrate deploy`; backfill chạy trên dữ liệu thật lần đầu ở đó.
- Form "Thêm phiên bản" vẫn gõ tên thuộc tính tự do (tự nối theo tên); bảng hàng hoá chưa hiện đơn vị.

## 2026-10-18 - Lịch sử giao của shipper (`GET /shipments/mine/history`)

**Đã làm**
- Route mới `GET /shipments/mine/history` (khai báo trên `:id`, không `@Permissions` như cả module - chỉ trả lần giao có `driverId` là người gọi). Query: `status` (một trạng thái hoặc `ACTIVE` = chưa kết thúc), `from`/`to` (YYYY-MM-DD, giờ VN), `search`, `page`/`limit`.
- Khoảng ngày áp lên `deliveredAt`; lần giao chưa từng giao (thất bại / hoàn / huỷ) rơi về `updatedAt`; lần giao **còn mở không bao giờ bị khoảng ngày giấu** (thẻ "cần giao" phải đếm cả đơn giao từ nhiều tuần trước). Sắp xếp `updatedAt` giảm dần (không phải `deliveredAt` - xấp xỉ, vì đơn giao xong có thể bị cập nhật thêm khi lắp đặt / nộp tiền).
- Response: `{ data, pagination, summary }`. `summary` = số lần giao theo trạng thái (`active/delivered/failed/returned/cancelled`, chịu khoảng ngày, không chịu `status`/`search`) + `collectedTotal` (tổng khoản BALANCE đã PAID do mình thu, theo `createdAt` của khoản). Mỗi dòng có `collection` = `{ method, amount, status }` của khoản BALANCE mới nhất do mình thu (PAID / PENDING).
- `localDayWindow` và `shipmentSearchWhere` chuyển vào `shipment-view.ts`; `GET /shipments` dùng chung, không còn hai bản.
- FE: tab "Lịch sử giao" ở `/shipper` (thẻ số liệu bấm để lọc, lọc ngày mặc định 30 ngày, tìm kiếm, phân trang).

**Chưa kiểm chứng**
- Chưa viết test (unit / e2e) cho route mới, chưa thử với dữ liệu thật; mới qua `tsc` + `eslint`.

## 2026-10-19 - Giao thất bại giao lại được, xác nhận hàng hoàn về mới RETURNED

**Đã làm**
- `FAILED` không còn là trạng thái kết thúc của shipment: nó vào `ON_THE_ROAD_STATUSES` và ra khỏi `FINAL_SHIPMENT_STATUSES`. Hàng chưa về shop nên shipper vẫn thấy lần giao ở "Đơn giao của tôi", ghi nhật trình lại (`/events`) hoặc `deliver` (FAILED → DELIVERED) trong lần thử tiếp. Báo `fail` lần hai trên lần giao đã FAILED → 409 `SHIPMENT_STATUS_INVALID`.
- `fail` báo cho người phụ trách **và chủ shop** (trừ chính người báo). Nội dung đổi: hàng chưa về shop, shipper giao lại được, hàng về thì xác nhận ở chi tiết đơn.
- Route mới `POST /order-returns/confirm-failed-delivery` (`{ shipmentId, note?, items? }`), không `@Permissions` như `POST /order-returns`: service cho người phụ trách đơn hoặc ai có `orders:read` (trong phạm vi chi nhánh). Một lần bấm tạo phiếu hoàn `DELIVERY_FAILED` cho mọi dòng còn ngoài, nhận, kiểm (mặc định GOOD về kho đã xuất, `items` ghi đè từng dòng), rồi trong **cùng transaction** shipment FAILED → RETURNED và đơn → RETURNED (`inspect` có thêm hook `within`).
- API đơn trả thêm `latestShipmentStatus`; FE: badge "Giao hàng thất bại" khi đơn SHIPPING mà lần giao mới nhất FAILED, thanh bước đổi thành ... Đang vận chuyển → Giao hàng không thành công → Hoàn trả, nút "Xác nhận hàng đã hoàn về shop" ở chi tiết đơn, nút "Giao hàng" vẫn hiện để giao lại.

**Chưa kiểm chứng**
- Mới qua `tsc`, `eslint` và unit test hiện có; chưa viết e2e cho luồng fail → deliver lại / fail → confirm-failed-delivery, chưa thử trên dữ liệu thật.
- Mặc định mọi dòng về kho là GOOD: hàng hỏng trên đường phải khai qua `items` (FE chưa có ô chọn tình trạng).
- Index `shipments_one_open_per_order` vẫn loại FAILED khỏi "đang mở" (không đổi migration); kiểm tra ở app đã tính FAILED là mở.

## 2026-10-20 - Khai báo combo / combo lồng nhau trong danh mục (BE PR #41) + sửa theo review

**Đã làm**
- `POST /products`, `POST /products/:id/items` nhận `itemType` (`PRODUCT | COMBO | SERVICE`, chốt lúc tạo - `PATCH` không đổi được) và `comboComponents: [{ componentItemId, quantity }]`; `PATCH /products/items/:id` thay toàn bộ thành phần. Combo bắt buộc ≥ 1 món; danh sách rỗng gửi kèm hàng thường được bỏ qua.
- `products/combo-components.ts`: kiểm món cùng tenant, không trùng, không chứa chính nó, không thuộc hàng đã ngừng (`PRODUCT_COMBO_COMPONENT_DISCONTINUED`, nêu SKU); nạp đồ thị combo của shop rồi chạy lại `flattenCombo` cho combo đó và mọi combo chứa nó (vòng lặp / quá `MAX_COMBO_DEPTH` → `PRODUCT_COMBO_INVALID`). Ghi dưới **advisory lock theo tenant** (`combo-graph:<tenantId>`) - hai lần sửa đồng thời không cùng qua kiểm tra rồi tạo vòng.
- Phiên bản trả `comboComponents` (một tầng, thứ tự theo SKU, kèm `productId`, `thumbnailUrl`); `GET /products/items` trả thêm `itemType`, `productStatus`, `thumbnailUrl`.
- Chặn: xoá phiên bản / ngừng bán sản phẩm đang là món của combo còn bán → `PRODUCT_ITEM_IN_COMBO`; bật lại (`PATCH status`) một combo đã ngừng mà còn món (của **sản phẩm khác**) đã ngừng → `PRODUCT_COMBO_COMPONENT_DISCONTINUED`. Ghi thành phần, ngừng bán và bật lại cùng chạy dưới `lockComboGraph` trong transaction.
- `GET /products/items?excludeDiscontinued=true` lọc hàng đã ngừng ở BE (bộ chọn món combo dùng, để `limit` áp lên hàng chọn được).
- **Chỉ PRODUCT có tồn** (`holdsStock`, `inventories/stockable.ts`): phiếu kho (tạo / sửa qua `itemsById`, và lúc **nhận** / **duyệt kiểm kho** cho phiếu tạo trước bản sửa) và `POST /inventory` từ chối COMBO / SERVICE → `PRODUCT_ITEM_NOT_STOCKABLE`; YCSX cũng dùng `holdsStock`. Không chặn trong `openLot` (chạy theo từng dòng khi nhận, thêm query mỗi lần).
- Test: `combo-components.spec.ts`, `stockable.spec.ts`, e2e `test/product-combo.e2e-spec.ts` (13/13).

**Chưa kiểm chứng / còn lại**
- Thứ tự thành phần là theo SKU, không phải thứ tự nhập - giữ thứ tự nhập cần cột `position` (migration).
- Toàn bộ e2e: 282/283 - `order-ship.e2e-spec.ts` (fail báo thêm chủ shop, mục 2026-10-19) đỏ cả trên `dev` sạch, test chưa cập nhật theo hành vi mới.

## 2026-10-20 - `@BooleanQuery()` + test `order-ship` theo hành vi giao thất bại mới

**Đã làm**
- `src/common/decorators/boolean-query.decorator.ts`: một decorator cho cờ boolean tuỳ chọn trên query (`'true'`/`'false'` → boolean, vắng = `undefined`, giá trị khác → 400). Thay 9 bản `@Transform` tự viết ở 7 DTO (cash-drawer, holidays, inventory, order-journey, production-request ×2, products ×2, suppliers). **Đổi hành vi:** 6 bản cũ đọc mọi giá trị lạ (`?hasDebt=yes`) thành `false`; giờ trả 400. FE luôn gửi `'true'`/`'false'`.
- `test/order-ship.e2e-spec.ts`: `fail` báo người phụ trách **và chủ shop** (mục 2026-10-19), thêm case người báo không tự nhận thông báo. Toàn bộ e2e xanh lại: 284/284.

## 2026-10-21 - Xem / thêm khách hàng thành quyền mặc định của mọi nhân viên

**Đã làm**
- `customers:read` và `customers:create` vào `STAFF_BASE_PERMISSIONS`: mọi tài khoản STAFF có hai quyền này bất kể vai trò; chủ shop / admin vốn đã toàn quyền. Trình sửa vai trò không còn hiện hai ô này (BE lọc khỏi `GET /roles/permission-catalog`, `create`/`update` vai trò bỏ chúng khỏi những gì lưu). `customers:update` / `customers:delete` vẫn phải cấp qua vai trò.
- Lý do: tạo đơn cần tìm / thêm khách, khách có thể gặp bất kỳ nhân viên nào, và trang "Khách hàng" trên sidebar không bị ẩn theo quyền nên nhân viên thiếu `customers:read` vào là 403.
- FE: bỏ hai mã này khỏi `permission-sections.ts` (ô "Tạo đơn" và ô "Xem danh sách khách hàng").

**Lưu ý / chưa kiểm chứng**
- Đánh đổi: mọi nhân viên (cả kho, xưởng, shipper) xem được toàn bộ danh sách khách của shop (tên, SĐT, địa chỉ) và trợ lý AI cũng mở `searchCustomers` cho họ. Khách hàng không gắn chi nhánh nên không thu hẹp được theo nơi làm việc.
- Dòng `role_permissions` cũ đang chứa hai cặp này vẫn còn (vô hại, hợp với bộ mặc định), sẽ bị bỏ ở lần sửa vai trò tiếp theo. Không cần migration.

## 2026-10-21 - Dashboard "Hôm nay" lỗi 400 từ 00:00 đến 07:00 giờ VN

**Đã làm**
- `RangeIsForwards` (`stats/dto/stats-query.dto.ts`) so hai mốc bằng `resolveRange` thay vì `new Date(raw)`. `new Date('2026-10-21')` là 00:00 UTC = 07:00 giờ VN, nên khi FE gửi "hôm nay đến giờ" (`fromDate` = ngày trần, `toDate` = ISO lúc này) trong khoảng 00:00-07:00 giờ VN, BE coi là kỳ chạy ngược và trả 400 `VALIDATION_FAILED` cho `/stats/overview`, `/stats/revenue`, `/stats/top-products`, `/stats/orders-by-status`. Phần đọc dữ liệu vốn đã parse đúng giờ VN, chỉ validator lệch.
- Test: `stats/dto/stats-query.dto.spec.ts`.
