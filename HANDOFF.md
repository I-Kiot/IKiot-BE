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

## 2026-10-20 - Nhập hàng hóa từ file Excel (`/products/import`)

**Đã làm**
- `GET /products/import/template`: file `.xlsx` mẫu sinh theo cửa hàng - trang "Hàng hóa" (tiêu đề đỏ `(*)` = bắt buộc, xanh = thông tin hàng hóa chỉ điền ở dòng đầu, ghi chú trên từng ô tiêu đề, dropdown danh mục/thương hiệu/NCC/trạng thái/loại/Có-Không, cột mã hàng/SKU/mã vạch định dạng chữ để giữ số 0 đầu), trang "Hướng dẫn" (luật điền, bảng cột, ví dụ) và trang "Danh sách" (nguồn dropdown).
- `POST /products/import` (multipart `file`, `products:create`): mỗi dòng một SKU, các dòng cùng tên hàng hóa gộp thành các phiên bản; 3 cặp thuộc tính (tên / đơn vị / giá trị). Kiểm tra cả file trước, sai một dòng là không tạo gì, trả 400 kèm `errors: [{ row, column, message }]`. Kiểm: cột bắt buộc, số tiền (nhận `1.200.000`, `1,200,000`, `đ`), VAT 0-100, trạng thái/loại theo nhãn, danh mục (tên hoặc "Cha > Con", tên trùng phải dùng đường dẫn)/thương hiệu/NCC phải có sẵn, link ảnh, SKU trùng trong file và với cửa hàng, tên hàng đã có, thông tin hàng hóa mâu thuẫn giữa các dòng, đơn vị thuộc tính lệch, hai phiên bản giống hệt. Sau đó DTO của form chạy lại `class-validator` làm lưới an toàn.
- `ProductService.create` thành vỏ của `createMany` (dùng chung cho form và import, một transaction, quota cho cả lô qua tham số mới `adding` của `assertQuota`, cấp mã `SP` cho cả lô một lần). Danh mục/thương hiệu kiểm bằng một truy vấn cho cả lô.
- FE: nút "Nhập file" ở `/products` mở dialog kéo-thả file, nút "Tải file mẫu", hướng dẫn ngắn, bảng lỗi theo dòng; nhập xong tải lại danh sách.
- Test: `product-import.parser.spec.ts` (16 unit), `test/product-import.e2e-spec.ts` (tải template thật, điền, nhập, đọc bảng; file lỗi không tạo gì). `product-combo`, `smoke` e2e vẫn pass.

**Chưa kiểm chứng / giới hạn**
- Chưa thử qua HTTP thật (dev server + trình duyệt): route, multer và tải blob ở FE mới qua `tsc`/`eslint` + `di-check`; chưa mở file mẫu bằng Excel/Google Sheets để xem dropdown hiển thị.
- Không nhập combo, không nhập tồn kho đầu kỳ, không cập nhật hàng đã có (chỉ tạo mới). Kích thước (dài/rộng/cao/khối lượng) chưa có trong template vì DTO tạo hàng chưa nhận.
- Ô chọn NCC chỉ chọn được một giá trị; nhiều NCC phải gõ tay cách nhau bởi `;`.
- E2E chạy trên `ikiot_e2e` (đã `migrate deploy` các migration còn thiếu cho DB này).
- (2026-10-21) Bỏ hai cột "Ảnh hàng hóa" và "Ảnh mặt hàng" khỏi template và bộ đọc theo yêu cầu: ảnh được thêm trên web sau khi nhập. File mẫu và dialog có dòng hướng dẫn việc này. File cũ còn hai cột đó vẫn nhập được (cột lạ bị bỏ qua) nhưng ảnh trong đó không được lưu.
- (2026-10-21) Trang "Hướng dẫn" của file mẫu có thêm bảng ví dụ "Tên hàng hóa" và "Tên mặt hàng" (nằm trước ví dụ đầy đủ): mỗi dòng luôn tạo một mặt hàng, các dòng cùng tên hàng hóa gom thành một hàng hóa, bỏ trống tên mặt hàng thì tên được tự ghép. Đã kiểm bằng cách build rồi dựng trang hướng dẫn qua exceljs. Chưa mở bằng Excel thật để xem ô gộp.

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

## 2026-10-23 - `products.product_type` + màn Combo riêng (`/combos`)

**Đã làm**
- Migration `20261023100000_product_type`: thêm `products.product_type` (`PRODUCT | COMBO | SERVICE`, mặc định `PRODUCT`) + index `(tenant_id, product_type)`. Backfill: sản phẩm mà mọi SKU là COMBO (hoặc mọi SKU là SERVICE) nhận loại đó, còn lại là `PRODUCT`.
- Loại sản phẩm cố định lúc tạo (`UpdateProductDto` không có field này). **`itemType` của SKU luôn bằng `productType`** (`itemTypeFor`, `product-status.ts`): `POST /products` và `POST /products/:id/items` tự gán, client gửi `itemType` lệch → 400 `PRODUCT_ITEM_TYPE_MISMATCH`. `product_items.item_type` giữ nguyên vì đơn hàng / kho / tách combo đọc nó.
- Bộ lọc `?productType=PRODUCT,SERVICE` cho `GET /products`, `/products/search`, `/products/items`. **BE không có mặc định**: POS, dialog đơn và ô chọn món combo vẫn tìm mọi loại. Mỗi màn FE tự gửi loại của mình.
- FE: `/products` lọc `PRODUCT,SERVICE` (form tạo chọn Hàng hoá / Dịch vụ), route mới `/combos` lọc `COMBO` (tạo luôn là combo), cùng bộ component qua `ProductScreen` (`products/_constants/product-screen.ts`) truyền vào `ProductsProvider`. Dialog thêm phiên bản bỏ ô chọn loại. Màn combo ẩn cột tồn, lọc tồn và "Tìm ở chi nhánh khác"; ô "Có thể sản xuất" chỉ hiện với hàng hoá. Sidebar thêm "Combo".
- Test: e2e `product-combo` 15/15 (thêm case loại SKU theo sản phẩm, dịch vụ, lọc theo loại; bỏ case "combo dùng chính phiên bản anh em", vì kiểu dữ liệu đó không còn tạo được); toàn bộ e2e 286/286, unit 382/382. FE `tsc` + `build` qua.

**Chưa kiểm chứng / còn lại**
- Migration CHƯA áp vào `ikiot_db`; đã chạy trên `ikiot_e2e`. Trong `ikiot_db` có **1 sản phẩm lẫn loại**: "Bàn làm việc Oak" (tenant Nội thất Demo, id `61b52e17-…`, có cả SKU PRODUCT lẫn COMBO). Backfill sẽ cho nó là `PRODUCT`, nên SKU combo của nó nằm ở màn Hàng hoá. Cần tách tay: tạo combo mới ở `/combos`, ngừng SKU combo cũ.
- Không có ràng buộc DB nào giữ "SKU cùng loại với sản phẩm" (khác bảng, Postgres không CHECK được). Chỉ service giữ; ghi thẳng bằng Prisma (seed, test) vẫn lẫn được.
- Nhánh `feat/product-import-excel` chưa merge: chỗ tạo của import phải ghi `productType` và báo lỗi khi các dòng cùng tên sản phẩm khác loại (chủ dự án sẽ tự sửa).
- FE chưa mở trên trình duyệt; mới qua `tsc`/`build`.

## 2026-10-24 - Rà các file seed theo schema hiện tại

**Đã làm**
- Kiểm tra: cả 5 file `prisma/seed*.ts` type-check sạch với schema hiện tại, `check-permissions` OK. Đã chạy cả chuỗi seed (hai lần, để thử idempotent) trên DB tạm `ikiot_seedcheck`, sau đó xoá DB này. Không đụng `ikiot_db` / `ikiot_e2e`.
- `seed-furniture-test.ts`: thuộc tính SKU giờ ghi qua `writeItemDetails` (cùng hàm `ProductService` dùng). Trước đây seed ghi `details` trần, không có `product_attributes` / `attribute_id`, nên sản phẩm seed không có thuộc tính nào và form "thêm phiên bản" không có gì để chọn (lệch từ 2026-10-16). Ghi `productType: PRODUCT` rõ ràng. Bật `isManufacturable` cho **Tủ hồ sơ 3 cánh** và **Sofa góc Milan**: từ 2026-10-13 YCSX chỉ nhận sản phẩm có cờ này, nên K2 / K10 đang bị chặn `PRODUCTION_REQUEST_ITEM_NOT_MANUFACTURABLE`.
- `seed-c5-delivery.ts`, `seed-c6-pack.ts`: không chạy được nữa (cần shop "Nội thất IGM Demo" của `seed-furniture.ts`, file đã xoá). Chuyển sang shop "Nội thất Demo" (tìm theo chủ shop 0981189856), CN Hà Nội, SKU của bảng 1.5.3. Mỗi đơn seed giờ có hoá đơn SALE `PENDING` qua `InvoiceService.ensurePending` (quy tắc mỗi đơn một hoá đơn, 2026-10-10). C5: tổng đơn = giá thật của `BAN-OAK-120` (3.000.000đ, cọc 900.000đ) thay cho 1.000.000đ tự đặt. C6: kho riêng "Kho test đóng gói (C-6)" (`isSellable` vì đơn chỉ xuất từ nơi bán được) để không ăn vào tồn CN Hà Nội của K1-K11; khai báo 2 kiện chuyển từ tủ sang `SOFA-MILAN-L`.
- `seed.ts`: mô tả gói Plus / Plus Năm "Quản lý nhân sự & bảng lương" → "& lịch làm việc" (bảng lương đã gỡ ở `20261001120000`).
- `docs/tai-khoan-test-hanh-trinh.md` 1.5: combo / dịch vụ giờ tạo được; ghi cờ "Có thể sản xuất" của tủ và sofa; ghi những gì C5 / C6 thêm vào shop.

**Chưa kiểm chứng / còn lại**
- Dữ liệu đã seed trong `ikiot_db` không tự sửa: sản phẩm cũ vẫn không có thuộc tính và tủ / sofa vẫn chưa bật cờ sản xuất (seed tìm sản phẩm theo tên rồi bỏ qua). Muốn sửa thì tạo lại shop, hoặc bật cờ trên màn Hàng hóa.
- Mới kiểm bằng cách đọc DB sau khi seed. Chưa chạy tay các kịch bản C5 / C6 trên UI (đóng gói, webhook).
- Gói `features` vẫn có `hr_management` - cờ còn hợp lệ (ca / lịch / ngày lễ vẫn dùng), chỉ đổi dòng hiển thị.

## 2026-10-24 - Dữ liệu `ikiot_db`: chạy seed, tách SKU combo lẫn loại

- Đã chạy chuỗi seed trên `ikiot_db` (`prisma db seed`, account-role, furniture-test, c6, c5): thêm kho "Kho test đóng gói (C-6)", 6 đơn `C6-TEST-…`, 5 đơn `C5-…` (kèm hoá đơn PENDING), tài khoản ngân hàng giả và webhook key `test-key-local`.
- Mục 2026-10-24 trước nói sản phẩm cũ trong `ikiot_db` thiếu thuộc tính và cờ sản xuất. Đọc DB thì không đúng: thuộc tính đã gắn `attribute_id`, cả 5 sản phẩm đã bật `is_manufacturable`.
- SKU combo `SP000009` (bàn Oak 120 + kệ 5 tầng) được chuyển khỏi "Bàn làm việc Oak" sang sản phẩm COMBO mới "Combo Bàn làm việc Oak + Kệ sách", giữ id / SKU / thành phần. Sau đó không còn sản phẩm nào có `item_type` khác `product_type`.

## 2026-10-24 - Giá vốn combo tự tính từ các món

- BE: giá vốn của phiên bản COMBO = tổng `số lượng × giá vốn` từng món (`comboCostOf`, `combo-components.ts`). `writeComboComponents` ghi giá này khi tạo / sửa thành phần; `recomputeComboCosts` tính lại mọi combo phía trên (kể cả combo lồng) khi giá vốn một món đổi qua `updateItem`. `costPrice` trong DTO thành tuỳ chọn: bắt buộc với hàng thường / dịch vụ (`VALIDATION_FAILED`), bị bỏ qua với combo. `GET /products/items` và `comboComponents[].componentItem` trả thêm `costPrice`.
- FE: dialog tạo combo và dialog phiên bản combo không còn ô nhập giá vốn, thay bằng ô chỉ đọc (`ComboCostField`) hiện tổng xem trước; mỗi món trong danh sách hiện giá vốn của nó. Dialog tạo combo bỏ đoạn "Phiên bản đầu tiên…" và ghi chú "Combo không có tồn kho riêng…" (ghi chú này bị xoá khỏi `ProductTypeSelect` cho COMBO).
- Test: `combo-components.spec.ts` (comboCostOf), `product-combo.e2e-spec.ts` (giá combo + combo lồng + giá gõ tay bị bỏ qua) - e2e chạy trên `ikiot_e2e`, 16/16 qua.

**Chưa kiểm chứng / còn lại**
- Chưa mở UI bằng tay để xem ô giá vốn chỉ đọc và dòng giá vốn từng món.
- Combo đã có trong `ikiot_db` giữ giá vốn cũ (đang là số gõ tay hoặc 0) cho đến lần sửa thành phần / sửa giá vốn một món kế tiếp; chưa có migration backfill.
- Giá vốn món đổi qua đường khác `updateItem` (phiếu nhập, nếu sau này cập nhật giá vốn) sẽ không tự tính lại combo.

## 2026-10-29 - Bán combo ở màn check-out (`POST /orders/pos`)

**Đã làm**
- Lỗi gốc: `createPosSale` trừ kho theo đúng SKU trong giỏ nên bán combo luôn 400 `INSUFFICIENT_STOCK` (combo không có dòng tồn). Nay combo được bung như đường `POST /orders`: dòng COMBO cha mang giá, dòng con `COMBO_COMPONENT` / `SERVICE` giá 0; chỉ dòng giữ tồn (`STOCKED_LINE_TYPES`) bị trừ kho, mỗi dòng ledger gắn đúng `orderItemId` của dòng đó (trước đây ghép theo SKU).
- Tách phần bung combo khỏi `ManualOrderService` thành hàm thuần `orders/order-combo.ts` (`loadComboGraph`, `expandCombos`, `buildOrderItemRows`) để quầy và đơn tay dùng chung một bản. `ManualOrderService.expandCombos/buildItems` giữ lại làm lớp mỏng nên `OrderEditService` và các e2e dựng provider tay không phải đổi.
- `OrderService.updateStatus` (CANCELLED / RETURNED đơn quầy): chỉ hoàn kho các dòng giữ tồn. Trước đó vòng lặp đi qua cả dòng COMBO cha và `ifNeverDrawn` sẽ tạo lô tồn cho SKU combo.
- `GET /products/search`: tồn của combo = số bộ trên kệ (`products/combo-availability.ts`, `stockWithCombos`); mọi variant có thêm `availableStock` = tồn trên kệ (`stock − lockedStock`). Quyết định với chủ dự án: tính theo tồn trên kệ, combo toàn dịch vụ luôn bán được.
- FE `/check-out`: chọn hàng/combo hết tồn trên kệ không thêm được vào giỏ (click, Enter, "Mua nhanh"; có toast); số lượng trong giỏ bị chặn ở `availableStock` (nút +, ô gõ, chọn lại món đã có). Màn tạo đơn tay vẫn `allowOutOfStock`, không đổi.
- Test: `combo-availability.spec.ts` (unit), `test/pos-combo.e2e-spec.ts` (7 ca: số bộ theo món khan nhất, tính theo kệ, bán combo, trả hàng, thiếu một món bị rollback, cùng SKU ở hai dòng). Chạy trên `ikiot_e2e`: pos-combo + stock-lot-callers + order-* + product-combo + production-requests + inventory-lots + damaged-location + di-check = 16 suite / 218 ca qua; unit 38 suite / 393 ca qua; `tsc` và lint BE sạch, `tsc` FE sạch.

**Chưa kiểm chứng / còn lại**
- Chưa mở UI check-out bằng tay (không chạy dev server). Phần FE mới kiểm bằng `tsc` + đọc code; cảnh báo lint FE còn lại đều ở dòng có sẵn (any, set-state-in-effect, dấu nháy chưa escape).
- Chưa chạy `test/smoke.e2e-spec.ts` (HANDOFF cũ ghi nó chưa chạy từ khi đổi schema Location).
- Đơn quầy có combo chỉ trả được cả đơn (RETURNED), như đơn thường; chưa có trả một phần ở quầy.
- `stockAllLocations` của combo có thể cao hơn thực tế khi các món nằm ở nhiều chi nhánh khác nhau; chỉ để tham khảo. Màn chi tiết / danh sách sản phẩm vẫn hiện tồn combo là 0 (chỉ `search` tính số bộ).
- Giỏ chỉ chặn theo số đã tải lúc thêm; hai quầy cùng bán món cuối thì `deductStock` ở BE vẫn là nơi chặn thật.

## 2026-10-29 - Màn Combo: cột Tồn kho và tồn từng thành phần khi expand

**Đã làm**
- BE: `GET /products` trả cho sản phẩm COMBO `totalStock` / `totalStockAllLocations` bằng tổng số bộ của các variant combo (`comboProductTotals`, dùng lại `stockWithCombos`). Một thành phần hết thì cả combo = 0 (min theo tồn trên kệ, như ô tìm kiếm ở quầy).
- BE: `GET /products/:id`, `search` và `findItem` cho variant combo `stock` = số bộ, và mỗi `comboComponents[].componentItem` có thêm `stock`, `availableStock`, `stockAllLocations` (combo lồng báo số bộ của nó; dịch vụ = 0). Gom phép tính vào `stockFigures`, bỏ bản trùng trong `toItemResponse`.
- FE `/combos`: bật lại cột "Tồn kho" và bộ lọc tồn (`showStock: true`); thêm cờ `crossBranchSearch` để nút "Tìm ở chi nhánh khác" vẫn chỉ có ở màn Hàng hóa. Dòng expand của variant combo hiện "Tồn kho (số bộ)" và khối "Tồn kho thành phần" (`combo-stock-list.tsx`): số lượng mỗi bộ, tồn trên kệ, "đủ N bộ", thành phần khan nhất được tô nổi.
- Test: 3 ca mới trong `test/pos-combo.e2e-spec.ts` (danh sách combo, một thành phần hết, chi tiết kèm tồn thành phần). Chạy trên `ikiot_e2e`: 15 suite / 202 ca e2e qua; unit 38 suite / 393 ca qua; tsc + lint BE sạch, tsc FE sạch.

**Chưa kiểm chứng / còn lại**
- Chưa mở UI `/combos` bằng tay (chưa chạy dev server); FE mới kiểm bằng `tsc` + eslint + đọc code.
- Bộ lọc "Hết hàng / Sắp hết" của cột tồn lọc client-side trên trang đang hiển thị, như màn Hàng hóa.
- Combo gồm thành phần ở nhiều chi nhánh: "Toàn chuỗi" của combo là min theo tổng từng thành phần nên có thể cao hơn thực tế (chỉ để tham khảo).
- Tồn thành phần trong dòng expand là tồn trên kệ (đã trừ hàng đóng gói cho đơn), không phải tồn vật lý.

**Chỉnh thêm (cùng ngày, màn Combo):** bỏ chữ "Toàn chuỗi" ở cột Tồn kho (cờ mới `ProductScreen.showChainStock`, bật ở Hàng hóa, tắt ở Combo) và bỏ "Toàn chuỗi" / "đủ N bộ" ở khối tồn thành phần. Thành phần khan nhất vẫn được tô nổi. Chỉ sửa FE; `stockAllLocations` của thành phần vẫn do BE trả nhưng FE không dùng nữa.

## 2026-11-04 - SePay: một webhook chung, tự đánh dấu "đã liên kết" (`feat/hungld-sepay-shared-webhook`)

**Đã làm**
- Webhook `POST /webhook/sepay/order` nhận thêm key chung `SEPAY_ORDER_WEBHOOK_API_KEY`: một webhook trên SePay của nền tảng phủ mọi tài khoản, shop được tìm theo `accountNumber` / `subAccount`. Key riêng từng shop vẫn chạy.
- `SepayAccountSyncService` đọc `GET /v2/bank-accounts` (token `SEPAY_API_KEY`) và đánh dấu `banking_sepay_linked_at`: mỗi 10 phút, sau khi shop lưu TK, và `POST /tenants/sepay-sync`.
- Chưa liên kết thì không phát QR: 400 `TENANT_SEPAY_NOT_LINKED` ở POS và giao hàng thu QR; FE khoá lựa chọn QR.
- STK: chuẩn hoá, unique theo shop (migration `20261104100000_tenant_banking_rules` chuẩn hoá số cũ; số trùng thì shop tạo sau bị xoá STK), không đổi được khi còn QR chờ (`TENANT_BANKING_HAS_PENDING_SEPAY`). Đổi số thì xoá cả `linkedAt` lẫn key riêng. `/tenants` của admin không còn ghi được các cột banking.
- `POST /webhook/sepay` (gói cước) bỏ qua tiền vào tài khoản khác `SEPAY_ACCOUNT_NUMBER`, để shop không tự chuyển cho mình mà kích hoạt được gói.
- POS ghi `payment_status`: PAID khi hoàn tất, REFUNDED khi trả hàng; migration sửa các đơn POS cũ.
- QR VietinBank có `SEVQR` trước mã đơn (quy định của ngân hàng).

**Đã kiểm chứng trên SePay thật**
- Giao dịch TPBank qua webhook chung: đơn POS COMPLETED, 1 dòng cash flow INCOME, hoá đơn ISSUED, kho trừ 1 lần. Trước phần sửa `payment_status`.
- Webhook phải **tắt "Chỉ gửi khi có mã thanh toán"**: bật thì SePay không nhận `ORD…` là mã thanh toán và không gửi gì. Giao dịch đã bị bỏ qua không tự gửi lại.

**Còn lại**
- Chưa có màn đối soát giao dịch đã về với đơn đang chờ; "Chuyển sang tiền mặt" sẽ ghi sai là tiền mặt.
- Dialog giao hàng của shipper chưa bấm thử trên trình duyệt (BE có e2e).
- `.env.{dev,prod}` trên VPS cần `SEPAY_ORDER_WEBHOOK_API_KEY` và `SEPAY_API_KEY`; webhook phải trỏ về API dev.
- Khách tự gõ nội dung vào VietinBank phải gõ cả `SEVQR`, màn hình chưa hiện.

## 2026-11-04 - Import Excel hàng hóa theo `productType`

**Đã làm**
- Cột "Loại mặt hàng" (cấp từng SKU, ghi `itemType`) đổi thành **"Loại hàng hóa"** ở cấp hàng hóa, ghi `productType` (bỏ trống = Hàng hóa; Dịch vụ; Combo vẫn bị từ chối). Lý do: từ khi có `productType`, mọi SKU phải cùng loại với sản phẩm. Parser cũ gửi `itemType: SERVICE` mà sản phẩm mặc định PRODUCT, nên một dòng "Dịch vụ" sẽ làm cả lần import lỗi `PRODUCT_ITEM_TYPE_MISMATCH` thay vì báo lỗi theo dòng.
- Parser không gửi `itemType` nữa, server tự suy ra qua `itemTypeFor`. Hai dòng của cùng hàng hóa ghi hai loại khác nhau thì báo lỗi theo dòng ("Khác với dòng X"), giống danh mục / thương hiệu.
- Template: cột mới đứng ngay sau "Tên hàng hóa", dropdown "Loại hàng hóa" ở trang Danh sách, dòng ví dụ ghi loại. Khi đọc file vẫn nhận tiêu đề cũ "Loại mặt hàng" (`aliases` trên cột), nên template đã tải trước đây vẫn import được.
- Test: unit `product-import.parser.spec.ts` sửa theo và thêm 1 ca (một loại cho mỗi hàng hóa). E2E `product-import.e2e-spec.ts` kiểm thêm `product.productType = SERVICE`.

**Chưa kiểm chứng**
- Chưa chạy `test:e2e` (docker không chạy). tsc, lint và unit (42 suite / 425 ca) đều qua.
- Chưa tải template mới ra mở bằng Excel để xem tận mắt.

## 2026-11-06 - Mã hàng duy nhất trong cửa hàng

**Đã làm**
- `product_items.product_code` duy nhất theo tenant: `@@unique([tenantId, productCode])` thay index thường, migration `20261106100000_product_item_unique_code`. SKU vốn đã unique, không đổi.
- Trước đây mã hàng không được kiểm tra ở đâu. Hai đường còn chép nguyên mã hàng của mặt hàng gốc: tạo phiên bản (`ProductVariantService.createVariant`) và hàng đặt riêng theo đơn (`OrderCustomizationService.apply`). Nay cả hai lấy mã hàng = SKU mới của chính nó (`<gốc>-V<n>`, `<gốc>-C<hex>`). Migration sửa dữ liệu cũ theo cùng quy tắc: trong mỗi nhóm trùng, dòng tạo sớm nhất giữ mã, các dòng còn lại lấy SKU của mình (nếu SKU đó chưa bị dùng làm mã hàng), không được thì lấy `<mã cũ>-<8 ký tự đầu id>`.
- `ProductService`: tạo hàng (`createMany`) và thêm phiên bản báo lỗi 400 `PRODUCT_CODE_DUPLICATE_IN_REQUEST` khi trùng trong cùng request, 409 `PRODUCT_CODE_TAKEN` khi trùng với mã đã có. `updateItem` cũng kiểm tra, và bỏ khoảng trắng ở mã hàng / SKU (để trống = giữ mã cũ, không ghi chuỗi rỗng nữa).
- Mã tự sinh `SP…` bỏ qua các mã gõ tay trong cùng lô. Trước đây DB đang tới SP000004 mà file gõ tay SP000005 thì dòng để trống cũng được cấp SP000005.
- Import Excel: báo lỗi theo dòng "Mã hàng … trùng với dòng N" / "… đã có trong cửa hàng". Ghi chú cột và trang Hướng dẫn được cập nhật. Thêm 1 ca unit test cho parser.

**Kiểm chứng**
- tsc, lint, build, unit (42 suite / 426 ca), e2e toàn bộ trên `ikiot_e2e` (23 suite / 303 ca) đều qua.
- Đã chạy thử phần sửa dữ liệu của migration trên `ikiot_db` local trong transaction rồi rollback: 1 cặp trùng (SP000001 của BAN-OAK-120 và BAN-OAK-120-V1) → dòng V1 được đổi thành mã `BAN-OAK-120-V1`. **Chưa chạy migration thật trên `ikiot_db`.** Môi trường dev / prod cũng cần `pnpm run deploy:migrate`.

**Còn lại**
- So khớp mã vẫn phân biệt hoa thường (như SKU): `ban-01` và `BAN-01` vẫn được coi là hai mã khác nhau.
- Mã vạch vẫn chưa có ràng buộc (giữ nguyên theo yêu cầu).
- FE: đã thêm bản dịch cho hai code mới trong `IKiot-FE/src/lib/api/error-codes.ts`.

## 2026-11-06 - Mã vạch duy nhất trong cửa hàng

**Đã làm**
- `product_items.barcode` duy nhất theo tenant khi có điền: `@@unique([tenantId, barcode])`, migration `20261106110000_product_item_unique_barcode`. NULL = không có mã vạch, được lặp lại.
- Form tạo hàng từng ghi mã vạch trống là `''` (DB local có 5 dòng như vậy), mà nếu giữ `''` thì các dòng này sẽ đụng nhau. Migration đổi chúng thành NULL. Code chuẩn hoá qua `normalizeBarcode` (bỏ khoảng trắng hai đầu, trống → null) ở tạo hàng, thêm phiên bản và sửa phiên bản. Khi sửa, mã vạch trống nghĩa là **xoá** mã vạch; khác với mã hàng / SKU, trống nghĩa là giữ mã cũ.
- Lỗi: 400 `BARCODE_DUPLICATE_IN_REQUEST`, 409 `BARCODE_TAKEN`; FE có bản dịch. Import Excel báo lỗi theo dòng ("Mã vạch … trùng với dòng N" / "… đã có trong cửa hàng"); ghi chú cột và trang Hướng dẫn được cập nhật.
- Nếu DB đã có mã vạch thật bị trùng, migration **dừng và liệt kê** các mã đó, không tự chọn mặt hàng giữ mã. Sửa tay rồi chạy lại.
- Tạo phiên bản và hàng đặt riêng không chép mã vạch của mặt hàng gốc (đã kiểm tra), nên không phải sửa hai chỗ này.

**Kiểm chứng**
- tsc, lint, build, unit (42 suite / 427 ca, thêm 1 ca parser), e2e toàn bộ trên `ikiot_e2e` (23 suite / 303 ca; smoke kiểm thêm 409 mã hàng / mã vạch, 400 trùng trong request, `barcode: ''` → null).
- Chạy thử cả hai migration hôm nay trên `ikiot_db` trong transaction rồi rollback: qua, 13/13 mặt hàng có barcode NULL. **Chưa chạy thật trên `ikiot_db`, dev, prod.**
## 2026-11-07 – Đơn khách tới lấy: chặn thu trùng và hoàn được tiền thu tại quầy (PR #54, FE PR #51)

- Đã thu tiền tại quầy thì không đổi sang giao tận nơi (`ORDER_PICKUP_ALREADY_COLLECTED`), vì shipper thu theo `grandTotal − cọc`. Chưa có tiền về thì đổi được, khoản QR đang chờ bị huỷ.
- `resolveRefund` tính cả `BALANCE` đã thu vào số đang giữ. Đơn giao tận nơi chỉ có `BALANCE` sau khi giao, lúc đó không huỷ được nên không đổi hành vi. `depositHeld` giữ nguyên cho kiểm tra khi sửa đơn.
- Huỷ đơn cũng huỷ khoản QR tại quầy đang chờ. Khoản thu qua QR mặc định hoàn bằng `BANK_TRANSFER`.
- Bộ lọc `DUE_SOON` bỏ đơn khách quá hạn lấy, để badge không đếm hai lần.

**Chưa kiểm chứng:** máy không có Postgres nên chưa chạy `test:e2e`, gồm 2 case mới trong `test/order-pickup.e2e-spec.ts`.
**Còn lại:** FE chưa có màn huỷ đơn hành trình kèm số tiền hoàn. `CashFlow` vẫn chưa ghi tiền cọc, tiền thu khi giao và tiền thu tại quầy (E-5).

## 2026-11-07 – Sổ thu chi cho đơn hành trình (E-5, phần CashFlow) và nút Huỷ đơn

- `writePaymentCashFlow` (`orders/order-cash-flow.ts`): mỗi `Payment` tiền đã đổi chủ là một dòng `CashFlow` (`paymentId` unique). Cọc ghi khi tạo đơn; tiền thu tại quầy ghi khi thu; QR ghi khi webhook báo về, theo số thực nhận; tiền mặt shipper ghi ở `confirm-remittance`; hoàn tiền khi huỷ là dòng EXPENSE. Không cần migration.
- Tiền giữ lại khi huỷ không ghi thêm dòng: dòng thu lúc nhận tiền vẫn còn.
- FE: nút "Huỷ đơn" cạnh "Sửa đơn", nhập số tiền hoàn (0 = shop giữ lại), lý do, cách hoàn (`cancel-order-dialog.tsx`).

**Đã kiểm chứng:** `test:e2e` 317/317 trên Postgres local (gồm cả các case của mục trên).
**Còn lại:**
- Đơn tạo trước thay đổi này không có dòng sổ cho khoản đã thu. Không backfill vì dev chỉ có dữ liệu test; cần xem lại trước khi lên prod.
- Đối soát két tính mọi dòng CASH ở chi nhánh, nên tiền shipper nộp cho chủ mà không bỏ vào két sẽ báo thiếu.
- Trả hàng (`order-returns`) chưa ghi `Payment` hoàn tiền, nên cũng không có dòng sổ.

**Sửa thêm:** huỷ và hoàn 0 thì giữ nguyên `paymentStatus` của đơn, đúng contract. Trước đó `resolveRefund` gán cứng `PARTIALLY_PAID`, nên đơn đã thu đủ tụt về "Đã cọc".

## 2026-11-07 – Tạo đơn chọn được nguồn hàng từ kho, kho tạo được đơn

- Trước đây form tạo đơn không có ô chọn, luôn lấy mặc định của chi nhánh, dù `sourceLocationId` đã có ở API.
- `GET /orders/source-locations` (`orders:create` hoặc `orders:update`): chi nhánh và kho còn hoạt động, trừ kho hàng hỏng. Route riêng vì nhân viên bán hàng chỉ có `read_own` trên chi nhánh / kho.
- FE chọn một nguồn cho cả đơn, vì `pack` chỉ nhận đơn xuất từ một nơi. Dòng thêm mới khi sửa đơn đi theo nguồn của đơn.

- Đổi nguồn hàng của cả đơn: `PATCH /orders/:id` với `sourceLocationId`, chỉ khi còn `CONFIRMED`.

- Kho tạo được đơn tay: migration `20261107100000_warehouse_can_sell` thêm dòng `branches` cho mọi kho (chỉ INSERT), kho tạo mới cũng có. `Order.branchId` giờ là "địa điểm bán". Kho hàng hỏng không bán được (`LOCATION_NOT_SELLABLE`). Nhân viên ở kho xem đơn bán tại kho của mình (`postingOf`).
- Giữ chỉ cho chi nhánh: bán tại quầy, két, khuyến mãi theo chi nhánh, phân công `branchId` của nhân viên. Shopee để sau.
- Prod phải chạy `deploy:migrate` trước khi merge lên `main`, như mọi migration.

- Người phụ trách đơn phải làm việc tại địa điểm bán (`ORDER_ASSIGNEE_WRONG_LOCATION`), chủ shop không bị giới hạn. Chọn cách này thay vì mở phạm vi xem đơn cho người phụ trách ở nơi khác, vì ít việc hơn.
- FE `/reports` và dashboard tổng quan: chọn kho thấy đủ doanh thu của kho, như chi nhánh.

**Lưu ý:** yêu cầu sản xuất đang mở giữ nguyên nơi nhận, nên sau khi đổi nguồn hàng xưởng vẫn về nơi cũ; đơn sẽ báo thiếu ở nơi mới tới khi chuyển kho.

## 2026-11-08 – Đổi người phụ trách đơn: người đang phụ trách cũng đổi được, và ô chọn ở danh sách đơn

- `PATCH /orders/:id/assignee` bỏ `@Permissions('orders','update')`, kiểm trong service bằng `assertReassignAccess` (`order-handler.ts`): chủ shop, người đang phụ trách đơn, hoặc người có `orders:update`. Người khác → `ORDER_STEP_DENIED`. Vẫn chỉ trước Đang vận chuyển (chốt cùng ngày: không đổi khi hàng đang trên đường).
- Người đang phụ trách được qua phạm vi chi nhánh như các bước khác của đơn. Lúc ghi có điều kiện `assigneeId = mình`, hai người cùng giao lại thì người sau nhận `ORDER_STATUS_CONFLICT`.
- `GET /orders/:id/assignees` (mới, cùng luật quyền): nhân viên ACTIVE tại nơi bán và chủ shop, kèm `isOwner`, `isCurrent`. Cùng hàm `worksAt` với `assertAssignee`. Trước đây FE lấy từ `GET /users`, cần `users:read`, nên người phụ trách không có quyền đó thấy danh sách rỗng.
- Thông báo `ORDER_ASSIGNED` cho người mới, `ORDER_UNASSIGNED` cho người cũ, trừ chính người vừa đổi. Cả `PATCH /orders/:id` có `assigneeId` cũng báo.
- `GET /orders` mỗi dòng thêm `latestShipment: { id, status, carrierType } | null`, để FE đổi shipper ngay ở danh sách (`PATCH /shipments/:id/driver`, luật quyền không đổi). Không có migration.

**Đã kiểm chứng:** `tsc`, lint, build, `check-permissions`, unit 463/463, `test:e2e` 337/337 trên Postgres local (4 case mới trong `test/order-edit.e2e-spec.ts`).
**Chưa kiểm chứng:** chưa bấm thử trên dev.

## 2026-11-10 – Chọn người giữ két không cần quyền xem danh sách nhân viên

- Màn mở két và dialog báo cáo cuối ca trước đây lấy danh sách từ `GET /users`, cần `users:read` và trả cả hồ sơ nhân sự. Thu ngân thường không có quyền này nên nhận 403 và ô chọn rỗng. Màn mở két còn gọi API đó ngay khi vào trang, với mọi tài khoản, kể cả người không mở két được.
- `GET /cash-drawer-sessions/eligible-staff?branchId=` (`cash_drawers:open`): ai nhận được két khi mở két đầu ngày. Chi nhánh đi qua `resolveBranch` như `POST /cash-drawer-sessions`.
- `GET /cash-drawer-sessions/:id/handover-candidates` (`cash_drawers:report`): ai nhận được bàn giao. Chỉ người đang giữ két gọi được (`CASH_DRAWER_NOT_HOLDER`, chủ shop cũng vậy, cùng luật với `submitShiftLog`), phiên đã đóng → `CASH_DRAWER_CLOSED`, không gồm chính người gọi.
- Cả hai chỉ trả `{ id, profile: { firstName, lastName } }`. Lọc bằng `cashierWhere()`, đúng điều kiện `assertBranchAndStaff` dùng khi ghi, nên người hiện trong ô chọn không bao giờ bị từ chối lúc gửi.
- Không thêm cặp quyền mới, không có migration.
- FE: màn mở két chỉ tải danh sách khi bấm "Mở két đầu ngày" (một chi nhánh) hoặc bấm vào chi nhánh (chủ shop xem nhiều chi nhánh); dialog báo cáo cuối ca gọi `handover-candidates`. Ô chọn không còn hiện tên role.

**Đã kiểm chứng:** `tsc`, lint, build, `check-permissions`, unit 463/463, `test:e2e -- smoke` 52/52 trên `ikiot_e2e` (thêm kiểm tra cho hai route trong kịch bản két). FE: `tsc` sạch.
**Chưa kiểm chứng:** chưa chạy toàn bộ `test:e2e`, chưa bấm thử trên dev.

## 2026-11-10 – Lịch sử thao tác trên đơn (order_events)

- Bảng `order_events` (migration `20261110100000_order_events`): chỉ ghi thêm, mỗi dòng là một thao tác trên đơn - loại (`type`, CHECK `order_events_type_check`), chuyển trạng thái nếu có (`from_status`/`to_status`), nguồn (`USER | SYSTEM | WEBHOOK`), người làm (id + tên + vai trò **chụp lúc ghi**), `changes` (trước/sau, giá trị đã đổi sang dạng hiển thị: tên thay id, số thay Decimal) và `metadata` (chứng từ liên quan: lần giao, phiếu hoàn, YCSX, đơn khác). `occurred_at` mặc định `clock_timestamp()` (không phải `now()`) và mỗi sự kiện insert riêng, để các sự kiện cùng transaction vẫn đúng thứ tự. FK: đơn CASCADE, người làm SET NULL (e2e dọn bằng xoá cứng).
- Route `GET /orders/:id/events` (`orders:read`, cùng 404 / 403 chi nhánh với `GET /orders/:id`, dùng chung `assertVisible` trong `OrderReadService`): cả danh sách, cũ nhất trước, không phân trang. Kiểu trả về và 29 loại sự kiện nằm ở `docs/api-contract-order-flow.md` §2.
- Helper `orders/order-events.ts` (`recordOrderEvent(s)`, `diffOrderFields`, `diffOrderLines`, `actorSnapshot`, `displayNamesOf`) và hằng `common/constants/order-event-type.ts`. Mỗi chỗ ghi nằm **trong transaction của thay đổi, ngay sau lệnh chiếm trạng thái thành công**: lần bị từ chối hoặc thua cuộc đua không để lại gì. Thêm loại sự kiện = migration mới tạo lại CHECK; `order-event-type.spec.ts` so danh sách trong migration với `ORDER_EVENT_TYPES`.
- Điểm ghi: tạo đơn tay (CREATED, DEPOSIT_RECORDED), POS (CREATED, STATUS_CHANGED, PAID_OFFLINE), webhook SePay đơn quầy và webhook SePay thu khi giao (QR_PAID, source WEBHOOK), sửa đơn (EDITED, ASSIGNEE_CHANGED, PRIORITY_CHANGED), làm riêng dòng, huỷ, xác nhận nộp tiền, thu tiền mặt tại quầy + giao tại quầy, đóng gói, shipment (tạo, lấy hàng, đổi shipper, đang vận chuyển, đi giao, giao thất bại), giao thành công / thu tiền mặt khi giao, hoàn hàng (tạo, hàng về, kiểm, huỷ, gắn đơn mua lại - ghi ở cả hai đơn), yêu cầu sản xuất (gửi xưởng, nhận hàng, mỗi đơn có dòng trong YCSX một sự kiện).
- Các chỗ trước đây ghi **ngoài transaction** nay bọc `$transaction` (hành vi ngoài và mã lỗi không đổi): `setAssignee` / `setPriority` (`claimUnshipped`), `ShipmentService.changeDriver`, `OrderReturnService.create / receive / cancel / setReplacementOrder`, bước "hàng về" của `confirmFailedDelivery` (tách `claimReceived` dùng chung với `receive`), `ProductionRequestService.updateStatus`. `settleOrder` của hoàn hàng nay trả `{ from, to } | null` (đơn có thật sự sang RETURNED hay không).
- Không backfill (đơn cũ không có nhật ký, chỉ là dữ liệu mẫu), không đổi seed, không thêm quyền. Hiện QR tại quầy không ghi gì (chưa có tiền về); QR_PAID ghi khi webhook báo về, kể cả khi đơn không còn chờ khoản đó (`metadata.orderSettled: false`, không có chuyển trạng thái).
- Nhược điểm đã biết: `confirmFailedDelivery` vẫn gồm ba transaction nên có thể để lại nhật ký dở (đã tạo phiếu hoàn mà chưa kiểm). Sự kiện của `QR_PAID` ở `completeSepayOrder` không ghi khi chuyển thiếu (bị từ chối trước transaction, đúng ý).
- FE hiện nhật ký: làm riêng ở `iKiotMS-FE` (thẻ "Lịch sử đơn hàng" trên trang chi tiết đơn).

**Đã kiểm chứng:** `prisma format`, `prisma generate`, `tsc`, lint, build, `check-permissions`, unit 528/528, `test:e2e` 383/383 (30 suite) trên Postgres local sau khi áp migration. Test mới/đã mở rộng: `order-events.spec.ts`, `order-event-type.spec.ts`, và các suite `order-journey` (chuỗi đầy đủ + route), `order-edit`, `order-pack`, `order-cancel`, `order-pickup`, `order-ship`, `order-return`, `order-reads`, `order-customization`, `smoke`.
**Chưa kiểm chứng:** chưa áp migration lên DB dev/prod (prod vẫn `deploy:migrate` tay), chưa bấm thử trên dev, chưa test `production-deliveries` receive riêng (đi qua `receiveGoods` chung, được journey kiểm gián tiếp).

## 2026-11-10 – Mã QR SePay hết hạn sau 15 phút

- **Vấn đề**: mã QR SePay không có hạn. Khách quét mã cũ khi đơn đã huỷ hay shipper đã thu tiền mặt thì tiền về mà không ai biết; đơn quầy chờ QR giữ hàng mãi.
- **Migration `20261110110000_sepay_qr_expiry`**: `payments.expires_at` (khoản QR đang có từ trước được gán `created_at + 15 phút`), `Payment.status` thêm `EXPIRED`, index `payments(status, expires_at)` và `orders(status, created_at)`, bảng `sepay_transactions` (unique `(tenant_id, sepay_transaction_id)`, CHECK `outcome`).
- **`orders/sepay-qr.ts`**: hạn 15 phút (hằng số), `sepayQrView` là cửa duy nhất tới `buildSepayQrUrl` (spec quét source), `isQrExpired` / `effectiveQrStatus` / `isAwaitingQrTransfer` / `decideSepayTransfer`, sổ giao dịch (`claimSepayTransaction`), `rejectLateSepayTransfer`.
- **Cron `SepayQrExpiryCron`** (5 phút): huỷ đơn quầy chờ QR quá hạn (hàng về kho, hoá đơn nháp huỷ, sự kiện `CANCELLED` nguồn `SYSTEM`, socket `order:cancelled`) và đánh dấu khoản thu khi giao / tại quầy `EXPIRED` (đơn giữ nguyên).
- **Route mới**: `POST /orders/pos/:id/cancel` (`orders:create` huỷ đơn của mình, `orders:update` huỷ của ai), `POST /shipments/:id/reissue-qr`. `POST /orders/pos` trả thêm `qrExpiresAt`; `payment` của shipment có `expiresAt`, `expired`, `status 'EXPIRED'`; `pickup/collect` có `payment.expiresAt`, hết hạn thì phát mã mới. Lỗi mới: `QR_PAYMENT_EXPIRED`.
- **Webhook**: tính hết hạn trước. Đơn / khoản còn chờ thì chốt kể cả mã đã hết hạn (`QR_PAID.lateAfterExpiry`, sổ `SETTLED_LATE`); đơn đã huỷ / đã thu, khoản bị tiền mặt hay mã mới thay → ghi sổ `REJECTED`, không đổi đơn, không `CashFlow`, thông báo `ORDER_LATE_TRANSFER` cho chủ shop. Giao dịch trùng (cùng mã SePay) bị sổ chặn; webhook trả `success: true` cho cả trùng lẫn bị từ chối (smoke test replay đổi từ `false` sang `true`).
- **Đổi hành vi**: trước đây khoản QR `PENDING` mà đơn không còn chờ nó vẫn được `PAID` + ghi `CashFlow`; nay bị từ chối và chủ shop đối soát tay. `PATCH /orders/:id/status` → `CANCELLED` của đơn quầy `PENDING` đi qua cùng hàm huỷ (có `cancelledAt`/`cancelReason`, sự kiện `CANCELLED` thay vì `STATUS_CHANGED`). `completeSepayOrder` trả `{ message } | null` thay vì đơn. `pendingCounterQr` đổi tên `openCounterQr` (gồm cả `EXPIRED`).
- **Test**: `sepay-qr.spec.ts` (unit), `test/sepay-qr-expiry.e2e-spec.ts` (16 ca: cron đơn quầy + chạy song song, huỷ tay, hết hạn khi giao, tạo lại mã, tiền mặt sau hết hạn, tiền về muộn chốt / từ chối, trùng giao dịch, thu tại quầy). Cleanup e2e của smoke / order-ship / order-pickup xoá `sepay_transactions` trước tenant.
- **Chưa kiểm chứng**: SePay có gọi lại khi nhận `success: false` không (sổ làm việc gọi lại vô hại); độ lệch đồng hồ FE / server (BE kiểm lại hạn ở mọi lần đọc / ghi); chưa áp migration lên DB dev/prod (prod vẫn `deploy:migrate` tay); chưa bấm thử trên dev. Cron quét mọi tenant nên khi test với `now` giả trên DB dùng chung thì đơn quầy chờ QR cũ của tenant khác cũng bị huỷ.
- Việc FE (làm riêng ở `iKiotMS-FE`): đếm ngược theo `expiresAt`, nút "Hủy đơn này" / "Tạo lại mã QR", lắng nghe `order:cancelled`, mã lỗi `QR_PAYMENT_EXPIRED`.

## 2026-11-11 – Sổ tiền: nền (Phase 1) và sửa lỗi đua / tiền ma (Phase 2)

Làm theo `ledger-plan.md` Phase 1-2 (BE), nhánh `feat/hungld-order-events`, cộng các quyết định D1-D9 của chủ dự án (D1: không thêm quyền; D8: cột `cash_flows.fund`). Chưa commit.

- **Migration `20261111090000_money_foundations`**: `orders.completed_at` (+ CHECK `orders_completed_at_required`, index); `cash_flows.category` (CHECK + CHECK hướng thu / chi suy từ loại) và `cash_flows.fund` `DRAWER | OWNER | BANK` (CHECK; CHECK `cash_flows_drawer_is_cash`; dữ liệu cũ: tiền mặt shipper đã nộp và tiền mặt trả NCC → OWNER, còn lại DRAWER / BANK); `payments.requested_amount`, `cancelled_at`, `cancelled_by`, `remittance_note` (+ CHECK `payments_kind_check` thêm `CHANGE`, CHECK `payments_outflow_has_origin` NOT VALID); `cash_drawer_sessions.closed_at`; `stock_movement_requests.cancelled_by`. **Lệch so với kế hoạch**: CHECK `cash_flows_order_money_has_payment` **chưa thêm** (NOT VALID vẫn chặn dòng MỚI; đơn quầy chưa có Payment tới Phase 3 nên thêm sớm là chặn mọi lần bán tại quầy) - thêm ở migration Phase 3; CHECK `fund = DRAWER ⇒ có location` bỏ vì `location_id` là `ON DELETE SET NULL` (e2e xoá nơi bị chặn), thay bằng tham số `locationId: string` bắt buộc ở `writePaymentCashFlow`.
- **Code mới**: `common/utils/money.ts` (`toDong`, `sumDong`, `allocateProportional`, `sliceValue`), `orders/payment-status.ts` (`derivePaymentStatus`, `paymentTotals`, `syncOrderPaymentStatus`, `paymentRowsOf`), `orders/order-lock.ts` (`lockOrder`), `common/constants/cash-flow-category.ts` (`CashFlowCategory`, `CashFlowFund`, `flowTypeOf`, `fundOf`), `completedData(now)` trong `order-status.ts`, `PaymentKind.CHANGE`.
- **`paymentStatus` không còn đặt tay** ở đơn hành trình: tạo đơn tay + cọc, thu tiền mặt khi lấy hàng, giao (tiền mặt / QR), `payCash`, webhook SePay thu khi giao, huỷ, sửa đơn đều ghi khoản tiền rồi gọi `syncOrderPaymentStatus`. `pickupAmountDue`, `amountStillDueOf`, `depositHeld`, phần "đang giữ" của `resolveRefund` là lớp mỏng trên cùng quy tắc; `amountDueOf` (tổng − cọc) và `paymentStatusForDeposit` đã xoá. **Đổi hành vi**: đơn đã có hoàn tiền thì "còn phải thu" = 0 (trước đây `pickupAmountDue` cộng lại phần hoàn). **Ngoại lệ có chủ đích: đơn quầy (TAKEAWAY) chưa có Payment nên `createPosSale` / `payOffline` / `completeSepayOrder` / RETURNED vẫn đặt tay - Phase 3 chuyển nốt; không được gọi sync cho đơn quầy.**
- **`completedAt`** theo `completedData(now)` ở cả 8 chỗ chốt COMPLETED (tạo đơn quầy, `payOffline`, webhook SePay đơn quầy, giao không còn gì thu, webhook SePay thu khi giao, `confirm-remittance`, `pickup/hand-over`; `updateStatus` không còn đặt COMPLETED). Test ghi thẳng đơn COMPLETED vào bảng phải có `completedAt`.
- **Sổ thu chi**: `writePaymentCashFlow` nhận dòng `Payment` + `category` bắt buộc (hướng thu / chi suy ra; `CashFlow.amount = Payment.amount`). Tiền mặt shipper nộp (`confirm-remittance`) là **`fund = OWNER`**, tiền mặt trả NCC là OWNER, SePay / chuyển khoản là BANK, tiền mặt tại quầy là DRAWER. **Đối soát két chỉ đếm `fund = DRAWER`** (báo cáo một phiên và báo cáo khoảng). Thu tiền mặt khi khách tới lấy ghi vào **kho đóng gói** (`fulfillment.locationId ?? order.branchId`) - két chỉ có ở chi nhánh nên khoản này chưa nằm trong đối soát két nào (Phase 8 phải liệt kê). Đơn quầy vẫn ghi `cashFlow` trực tiếp trong `writeSaleCashFlows` (với category / fund) tới Phase 3; spec quét `src/` cho phép đúng ba file.
- **Webhook SePay thu khi giao** ghi `Payment.amount := transferAmount` và giữ số QR ở `requested_amount` (mọi khoản SEPAY mới có `requested_amount`). Chuyển thiếu vẫn chưa xử lý (Phase 4).
- **Phase 2**: (1) `pickup/collect` khoá đơn, tính lại số còn thu trong transaction, claim thêm `paymentStatus != PAID` + `updatedAt`; (2) `PATCH status` → COMPLETED của đơn quầy chờ SePay trả `ORDER_USE_PAY_OFFLINE`, bỏ COMPLETED khỏi `VALID_ORDER_TRANSITIONS[PENDING]`, dòng tiền RETURNED ghi người bấm; (3) huỷ đơn khoá đơn + tính hoàn tiền trong transaction + claim `updatedAt`; (4) sửa đơn: `ORDER_EDIT_LOCKED_BY_PAYMENT` / `ORDER_TOTAL_BELOW_PAID` (chỉ áp cho đơn đã có khoản FULL / BALANCE; đơn chỉ có cọc giữ luật cọc cũ, nên test "deposit lớn hơn tổng mới" vẫn trả `ORDER_DEPOSIT_EXCEEDS_TOTAL`), khoá đơn trong transaction; (5) mọi lần huỷ khoản tay ghi `cancelled_at / cancelled_by`; (6) ghi chú của chủ khi xác nhận nộp tiền vào `remittance_note`, `Payment.note` không bị sửa; (7) phiếu kho: `claim()` có điều kiện trạng thái ở `open`, `close`, `ship`, `receive`, `approve-adjust`, `cancel`, `updateDetails` → `STOCK_MOVEMENT_CONFLICT`, ghi người / lúc xuất, nhận, duyệt, huỷ, response có `shippedBy / receivedBy / approvedBy / cancelledBy`. `finalize` két ghi `closed_at`.
- **Test**: unit `money`, `payment-status`, `cash-flow-category` (CHECK khớp migration, quét `cashFlow.create`), `order-cash-flow`, `assertEditAllowedByPayments`, `completedData`; e2e `order-pickup` (hai `collect` tiền mặt đua nhau, quỹ DRAWER tại kho đóng gói, huỷ đua với thu), `order-edit` (sửa sau khi đã thu tại quầy), `smoke` (PATCH COMPLETED đơn SePay chờ → 409 không có dòng tiền; hai `receive` / hai `cancel` phiếu kho cùng lúc; đối soát két bỏ qua dòng OWNER), `order-remittance` (`remittanceNote`, quỹ OWNER). Helper mới `test/helpers/money-invariants.ts` (`assertMoneyInvariants`, gọi cuối `order-journey`, `order-pickup`, `order-ship`, `smoke`; hai suite dựng dữ liệu thẳng vào bảng bỏ hai kiểm phụ thuộc việc code đã ghi) và `cleanup-money.ts`.
- **Chưa kiểm chứng**: chưa áp migration lên DB dev / prod (prod vẫn `deploy:migrate` tay; migration có UPDATE backfill `category` / `fund` / `completed_at` nên dry-run trên bản sao trước); FE chưa đổi (mã lỗi mới, `STOCK_MOVEMENT_CONFLICT` toast + refetch, đừng gọi `PATCH … COMPLETED` ở màn quầy, `completedAt`); chưa kiểm hai request đua nhau trên nhiều instance (chỉ đua trong một tiến trình Jest).

## 2026-11-11 – Sổ tiền: đơn quầy có Payment (Phase 3) và sổ SePay đủ mọi giao dịch (Phase 4)

Làm theo `ledger-plan.md` Phase 3-4 (BE), nhánh `feat/hungld-order-events`, cộng quyết định D1-D9 của chủ dự án (D2: tiền chưa gắn đơn vào sổ thu chi `UNALLOCATED_RECEIPT`; D4: trả hàng đơn quầy luôn hoàn đúng số tiền đang giữ; D8: tiền shipper nộp là quỹ OWNER). Chưa commit.

- **Migration `20261111093000_pos_payments`**: CHECK `cash_flows_order_money_has_payment` (NOT VALID: dòng đơn quầy cũ được miễn) - mọi dòng `ORDER_PAYMENT` / `ORDER_REFUND` / `SALE_CHANGE` phải có `payment_id` và `order_id`. **Migration `20261111100000_sepay_ledger_completeness`**: `sepay_transactions` cho phép `tenant_id` / `sepay_transaction_id` / `payment_reference` null, thêm `dedupe_key` (NOT NULL, dòng cũ = `id:<mã>`), `account_number`, `content`, `bank_reference_code`, `transaction_date`, `excess_amount`, `resolved_at / resolved_by / resolution / resolution_note`; bỏ unique `(tenant_id, sepay_transaction_id)`, thay bằng hai unique một phần `(tenant_id, dedupe_key) WHERE tenant_id IS NOT NULL` và `(account_number, dedupe_key) WHERE tenant_id IS NULL`; CHECK `outcome` thêm `SETTLED_PARTIAL`, `UNMATCHED`; CHECK `resolution`; `cash_flows.sepay_ledger_id` (FK SET NULL) + unique một phần `(sepay_ledger_id, category)`.
- **Đơn quầy có `Payment`** (`orders/pos-payments.ts`): nhận ngay → `FULL` (+ `CHANGE` nếu thối, trỏ về `FULL`) mỗi khoản một dòng thu chi gắn đơn (dòng thối cũng có `orderId`, quyết định 7); SePay → `FULL` `PENDING` (`requested_amount`, `expires_at` = tạo đơn + 15 phút). `writeSaleCashFlows` bị xoá, `orders.service.ts` ra khỏi danh sách được phép `cashFlow.create` (spec quét còn `order-cash-flow.ts` + `suppliers.service.ts`). `orders.subtotal` đặt cho đơn quầy (`OrderPricingService.subtotalOf`, dùng chung với tạo / sửa đơn tay). Đơn giảm về 0đ không ghi khoản nào.
- **`payOffline`** khoá đơn, huỷ khoản QR còn mở (ghi người huỷ), thu **phần còn lại** theo quy tắc suy ra (`FULL` hay `BALANCE` + `CHANGE`), sự kiện `PAID_OFFLINE` thêm `change`, `paymentId`. **Trả hàng đơn quầy** (`PATCH status → RETURNED`) ghi `REFUND` + `ORDER_REFUND` qua `recordRefundPayment` (`orders/order-refund.ts`, dùng chung với huỷ đơn hành trình; `resolveRefund` / `depositHeld` chuyển sang file này để `orders.service` import được mà không vòng). **Huỷ đơn quầy chờ QR** khoá đơn, huỷ khoản QR, và đơn đã nhận một phần tiền bắt buộc `refundAmount` (`POST pos/:id/cancel` nhận `refundAmount`, `refundMethod`); cron không huỷ đơn có khoản `PAID`, hạn của đơn là hạn của mọi khoản QR còn mở. `cancelData` / `cancelCounterQr` chuyển sang `payment-cancel.ts` (cùng lý do vòng phụ thuộc).
- **Một đường chốt SePay** (`orders/sepay-settlement.ts`, `processSepayTransfer`): `completeSepayOrder` (quầy) và `settleSepayBalance` (giao / tại quầy) chỉ còn là hai lớp mỏng. Các bước trong một transaction: sổ → khoá đơn → chiếm khoản → dòng thu chi → `syncOrderPaymentStatus` → `nextStatusAfterPayment` (hàm thuần mới trong `order-status.ts`) → chiếm đơn COMPLETED + hoá đơn → sự kiện `QR_PAID`. Các dòng `cashFlow.create` trùng lặp bị xoá. `isAwaitingQrTransfer` thêm đơn quầy `PENDING`.
- **Chuyển thiếu là khoản trả một phần** (bỏ nhánh ném `ORDER_TRANSFER_AMOUNT_SHORT` và nhánh chỉ ghi log): khoản `PAID` với số thực nhận, sổ `SETTLED_PARTIAL`, đơn `PARTIALLY_PAID` chưa hoàn thành, `QR_PAID` kèm `partial` / `requested` / `due`, thông báo `ORDER_PARTIAL_TRANSFER`, socket `order:paid` thêm `partial` / `due` / `paymentStatus`. **Trả dư**: chốt đủ, `excess_amount` trên dòng sổ, thông báo `ORDER_OVERPAID` cho chủ (hoàn phần dư là Phase 6).
- **Thu nốt phần còn lại**: route mới `POST /orders/pos/:id/qr`; `payCash` (giao) cho phép khi `RECEIVED` và còn phải thu, số tiền do server tính, không cần khoản QR đang chờ (hết thu: `ORDER_COLLECTION_AMOUNT_MISMATCH`, trước đây `ORDER_QR_PAYMENT_NOT_PENDING`); `reissueQr` điều kiện `RECEIVED` + còn phải thu, số mã mới = số còn thu.
- **Sổ SePay đủ mọi giao dịch**: `sepayDedupeKey` (`id:` / `ref:` / `h:`), `claimSepayTransaction` là `INSERT … ON CONFLICT DO NOTHING RETURNING id` thô. Webhook ghi sổ cả khi không có mã đơn (`UNMATCHED / NO_REFERENCE`), mã lạ (`UNKNOWN_REFERENCE`), không có mã giao dịch, và tài khoản không thuộc shop nào (`UNKNOWN_TENANT`, không có tenant, chỉ khi webhook dùng **key dùng chung**; key sai / thiếu không ghi gì để người ngoài không làm đầy sổ - lệch nhẹ so với kế hoạch, có chủ ý). Từ chối (`REJECTED`) và không gắn được đơn ghi dòng thu chi `UNALLOCATED_RECEIPT` (quỹ BANK, không đơn, không nơi, gắn `sepay_ledger_id`); không tenant thì chỉ báo operator (`SYSTEM_SEPAY_UNMATCHED`). Webhook trả `success: true` cho tất cả những ca đã ghi sổ.
- **Nộp tiền shipper cho đơn `RETURNED`** (quyết định 4): `confirm-remittance` nhận `RECEIVED` và `RETURNED`; ghi dòng thu chi quỹ OWNER, đơn `RETURNED` giữ nguyên, sự kiện `REMITTANCE_CONFIRMED` có `fromStatus` / `toStatus` null; đơn `RECEIVED` chỉ hoàn thành khi `nextStatusAfterPayment` cho phép.
- **Module mới `sepay-transactions`**: `GET /sepay-transactions` (`cash_flows:read`, lọc `outcome`, `unresolved`, `from`, `to`) và `POST /sepay-transactions/:id/resolve` (`cash_flows:update`, một lần; `REFUNDED_MANUALLY` ghi `UNALLOCATED_REFUND`). Mã lỗi mới: `SEPAY_TRANSACTION_NOT_FOUND`, `SEPAY_TRANSACTION_ALREADY_RESOLVED`, `SEPAY_TRANSACTION_NOT_REFUNDABLE`. Không đổi catalog quyền.
- **Test**: unit `sepay-qr.spec` (`decideSepayTransfer` có `partial`, `sepayDedupeKey`, `sepayTransferFromPayload`, đơn quầy trong `isAwaitingQrTransfer`), `order-status.spec` (`nextStatusAfterPayment`), `cash-flow-category.spec` (danh sách ghi sổ rút còn hai file); e2e mới `test/sepay-ledger.e2e-spec.ts` (30 ca: đơn quầy tiền mặt có thối / chuyển khoản / SePay, chuyển thiếu + QR phần còn lại + `payOffline` phần còn lại, trả dư, trả hàng / huỷ có hoàn, thu khi giao thiếu → `payCash` / `reissueQr` → nộp tiền, đơn khách tới lấy thiếu, nộp tiền đơn `RETURNED`, không mã / mã lạ / không id / không tenant, trùng đồng thời, danh sách + resolve). `assertMoneyInvariants` thêm kiểm sổ SePay (dòng đã chốt có khoản đúng số tiền, dòng không chốt được có đúng một `UNALLOCATED_RECEIPT`) và kiểm trạng thái thanh toán cho cả đơn quầy; thêm vào `sepay-qr-expiry`, `pos-combo`, `order-remittance`, `order-cancel`; `order-ship` và `order-pickup` **bỏ hết skip** (fixture ghi cọc đúng: dòng thu chi + trạng thái suy ra). Cleanup e2e: xoá `cashFlow` TRƯỚC `payment` (FK SET NULL làm `payment_id` null và vi phạm CHECK mới).
- **Đã kiểm chứng**: `prisma format`, `generate`, `tsc`, lint, build, `check-permissions`, unit 599/599, `migrate deploy` trên Postgres local, `test:e2e` 443/443 (32 suite).
- **Chưa kiểm chứng**: SePay có luôn gửi `referenceCode` hay không (khoá `ref:` chỉ dùng khi có); nhiều instance chạy webhook song song (dựa vào unique index + khoá đơn, chưa thử); chưa áp migration lên DB dev / prod (prod vẫn `deploy:migrate` tay; migration Phase 3 chỉ thêm CHECK NOT VALID, migration Phase 4 có UPDATE `dedupe_key` nên dry-run trên bản sao); FE chưa đổi (`order.payments[]`, `order:paid` có `partial` / `due`, nút "Tạo mã QR số còn lại" gọi `POST /orders/pos/:id/qr`, màn `/sepay-transactions`, mã lỗi mới, hiển thị `order.amountDue` đúng sau chuyển thiếu).
- **Còn lại (Phase 5+)**: webhook nền tảng (Phase 5), hoàn tiền khi duyệt trả hàng + `refund-excess` + `paymentSummary` (Phase 6), nhật ký doanh thu và `OTHER_INCOME` cho tiền giữ lại khi huỷ (Phase 7), thống kê (Phase 8: tiền mặt shipper chưa nộp, quỹ OWNER, tiền mặt quầy ở kho không có két phải được báo cáo), công nợ NCC (Phase 9).

## 2026-11-11 – Sổ tiền: webhook nền tảng có sổ và chiếm hoá đơn (Phase 5), hoàn tiền khi trả hàng / khi khách trả dư (Phase 6)

Làm theo `ledger-plan.md` Phase 5-6 (BE), nhánh `feat/hungld-order-events`, cộng quyết định D1-D9 của chủ dự án (D1: **không thêm quyền**, hoàn tiền khi kiểm hàng và `refund-excess` dùng `returns:inspect`; D3, D5: tiền mặt hoàn ra từ quỹ chi nhánh của đơn; D6: nhiều lần chuyển thiếu không cộng dồn kích hoạt gói). Chưa commit.

- **Migration `20261111110000_platform_sepay_ledger`**: `subscription_invoices.amount_received`; bảng `platform_sepay_transactions` (`dedupe_key` unique, `outcome` CHECK `ACTIVATED | UNDERPAID | INVOICE_NOT_PENDING | UNMATCHED | NO_REFERENCE`, FK hoá đơn `SET NULL`, FK tenant `RESTRICT`). **Migration `20261111120000_order_refunds`**: tạo lại `order_events_type_check` thêm `REFUNDED` (không thêm dòng `permission_catalog`, không đổi seed `CATALOG`: quyết định D1).
- **Phase 5, `SubscriptionBillingService.settlePayment`** viết lại thành một transaction: tìm hoá đơn theo mã ở **mọi trạng thái** → quyết định kết cục → ghi sổ (`createMany skipDuplicates`, trùng thì trả `Duplicate transaction`, không làm gì thêm) → với `ACTIVATED` chiếm hoá đơn `PENDING → PAID` (kèm `amount_received`, `transaction_ref`) **trước** khi cập nhật gói, cùng transaction. Thua lệnh chiếm (hai giao dịch cho một hoá đơn) ném `PlatformClaimLost`, cuốn cả dòng sổ rồi quyết định lại một lần: giao dịch thứ hai thành `INVOICE_NOT_PENDING`. Hoá đơn `FAILED` / đã `PAID` không kích hoạt (quyết định 10); chuyển thiếu là `UNDERPAID` (ghi số vừa nhận, hoá đơn vẫn `PENDING`). Mọi kết cục trừ `ACTIVATED` gọi `notifySystem` type mới `SYSTEM_PLATFORM_TRANSFER_NEEDS_ACTION` (đã vào whitelist operator, mẫu `SubscriptionNotificationTemplates.platformTransferNeedsAction`). `activateAfterPayment` không còn. Tái dùng `sepayTransferFromPayload` / `sepayDedupeKey` của sổ shop.
- **Phase 6, `orders/order-refund.ts`**: `recordRefund(tx, …)` là nơi duy nhất ghi hoàn tiền ngoài huỷ đơn: đọc lại các khoản trong transaction, chặn trần (`HELD` = `derive.net`, `EXCESS` = `derive.overpaidBy`; vượt trần hay không có khoản đã nhận để trỏ về → 400 `ORDER_REFUND_EXCEEDS_PAID`, không ghi gì), khoản `REFUND` + dòng chi `ORDER_REFUND` (địa điểm = chi nhánh của đơn), `syncOrderPaymentStatus`, sự kiện **`REFUNDED`** (người bấm đứng tên). Dùng ở: kiểm hàng trả, trả hàng đơn quầy (`PATCH status → RETURNED`, lý do `POS_RETURN`, vẫn hoàn đủ số đang giữ như D4), và `refund-excess`. Huỷ đơn giữ sự kiện `CANCELLED` mang số hoàn.
- **`POST /order-returns/:id/inspect`** nhận `refund?: { amount, method?: 'CASH' | 'BANK_TRANSFER', note? }`: khoá đơn trước, đơn đang giữ tiền mà thiếu `refund` → 400 `ORDER_RETURN_REFUND_REQUIRED` (`held` ở thân lỗi), `amount: 0` = shop giữ; hoàn ghi sau `settleOrder`, vượt trần cuốn cả lần kiểm hàng. `confirm-failed-delivery` nhận `refund?` nhưng **không bắt buộc** (hàng chưa tới tay khách; bỏ qua = cọc vẫn do shop giữ; lệch nhẹ so với kế hoạch, vì flow đó không có màn nhập số hoàn). **`GET /order-returns/:id`** thêm `refundSuggestion` (`null` khi không `INSPECTING`): `goodsValue` = Σ `sliceValue` trên `netLineValues` (file mới `orders/sales-math.ts`, thuần; Phase 7 dùng lại cho hoá đơn và nhật ký doanh thu), `suggested = min(max, goodsValue)`, `max` = tiền đang giữ, phí giao không nằm trong gợi ý.
- **`POST /orders/:id/refund-excess`** (`returns:inspect`; `OrderExcessRefundService`): `{ amount, method, note? }` ≤ `overpaidBy`; hoàn hết phần dư thì dòng sổ SePay của đơn có `excess_amount > 0` chưa xử lý được đánh dấu `REFUNDED_MANUALLY` (có điều kiện `resolved_at IS NULL`, `resolvedBy` = người hoàn). **`GET /orders/:id`** thêm `paymentSummary { received, refunded, net, due, overpaidBy, pendingRemittance }` (`paymentSummaryOf`, cùng quy tắc với `orders.payment_status`).
- **Mã lỗi mới** (append-only): `ORDER_REFUND_EXCEEDS_PAID` (400), `ORDER_RETURN_REFUND_REQUIRED` (400).
- **Test**: unit `sales-math.spec`, `subscription-billing.service.spec` (mock `$transaction`), `order-event-type.spec` (CHECK khớp `REFUNDED`); e2e mới `test/platform-billing.e2e-spec.ts` (kích hoạt một lần, webhook gọi đôi, hai giao dịch một hoá đơn, hoá đơn `FAILED`, chuyển thiếu rồi đủ, không mã / mã lạ / không id, tài khoản shop không vào sổ), mở rộng `order-return` (hoàn đủ, hoàn một phần tiền mặt từ quỹ chi nhánh, lần sau hoàn 0, vượt trần cuốn lại cả lần kiểm, đơn chưa thu, trả trước khi hoàn thành với cọc, giao thất bại không cần hoàn), `sepay-ledger` (`refund-excess` từng phần rồi hết, đóng dòng sổ), `order-journey` (trả hàng hỏng có hoàn tiền + sự kiện `REFUNDED`), `smoke` (nhật ký trả hàng đơn quầy có `REFUNDED`). `assertMoneyInvariants` thêm kiểm sổ nền tảng (`ACTIVATED` ⇒ hoá đơn `PAID` đúng số, mỗi hoá đơn tối đa một lần kích hoạt) và hoàn tiền (có khoản gốc, có người làm); `deleteTenantMoneyTrail` xoá sổ nền tảng của tenant.
- **Đã kiểm chứng**: `prisma format`, `generate`, `tsc`, lint, build, `check-permissions`, unit 603/603, `migrate deploy` trên Postgres local, `test:e2e` 458/458 (33 suite).
- **Chưa kiểm chứng**: nhiều instance webhook nền tảng song song (dựa vào unique `dedupe_key` + lệnh chiếm hoá đơn, chưa thử); SePay có luôn gửi `referenceCode`; migration chưa áp lên DB dev / prod (prod vẫn `deploy:migrate` tay, dry-run trên bản sao trước); FE chưa đổi (khối hoàn tiền ở màn kiểm hàng, banner "Khách trả dư", mã lỗi mới, thông báo operator).
- **Còn lại**: nhật ký doanh thu và `OTHER_INCOME` (tiền giữ lại khi huỷ, và khi trả hàng trước lúc hoàn thành, D3) ở Phase 7; hoàn tiền mặt lấy từ quỹ chi nhánh của đơn (D5) kể cả khi tiền ban đầu do shipper thu (quỹ OWNER) hay thu tại quầy kho; chưa có route đọc `platform_sepay_transactions`.

## 2026-11-11 - Sổ cái tiền, Phase 7: nhật ký doanh thu chỉ ghi thêm + chia giảm giá vào hoá đơn

Làm theo `ledger-plan.md` Phase 7 (BE), nhánh `feat/hungld-order-events`, cộng quyết định D1-D9 (D3: tiền giữ khi trả hàng trước hoàn thành → `OTHER_INCOME`; D9: không backfill). Doanh thu theo kiểu kế toán: SALE vào ngày đơn COMPLETED, RETURN ghi **âm** vào kỳ xảy ra trả hàng, kỳ cũ không đổi, dòng không bao giờ bị sửa.

- **Migration `20261111130000_sales_journal`**: bảng `sales_journal_entries` (`entry_type` SALE | RETURN | OTHER_INCOME, `business_date` DATE giờ Việt Nam, `posted_at` = `clock_timestamp()`, `goods/shipping/other_income/total_amount`, `cogs_amount`, `shipping_cost`, `channel_fee`, ảnh chụp khách / người phụ trách / người tạo / kênh, `source`, `actor_id`) và `sales_journal_lines` (`order_item_id`, `product_item_id`, `quantity`, `amount`, `cogs`); CHECK dấu và `total = goods + shipping + other`; index duy nhất một phần `sales_journal_one_sale`, `_one_other_income`, `_one_per_return`, `_one_pos_return`; **trigger chặn UPDATE** (DELETE vẫn được cho cascade và dọn dẹp e2e; ngoại lệ duy nhất là `ON DELETE SET NULL` của `actor_id`); `invoice_lines.discount_amount`. Đây là trigger đầu tiên của dự án (ghi trong CLAUDE.md "Data layer").
- **Code**: `orders/sales-math.ts` mở rộng (`keptLineValues`, `saleEntryAmounts`, `returnEntryAmounts`), `orders/sales-journal.ts` (`postSale`, `postReturn`, `postPosReturn`, `postOtherIncome`), `common/constants/sales-journal.ts`. Giá vốn lấy từ **sổ lô** (`inventory_transactions`: Σ(−số lượng × giá lô) của SALE, SALE_REVERSAL, RETURN_GOOD, RETURN_DAMAGED), không dùng `costPrice` danh mục.
- **Chỗ ghi**: SALE ở `createPosSale`, `payOffline`, `processSepayTransfer`, `deliver` (không có gì để thu), `confirm-remittance`, `handOver` (sau `shipLockedStock`). RETURN ở `OrderReturnService.inspect` và đơn quầy RETURNED. OTHER_INCOME ở `OrderCancelService.cancel`, `cancelPendingPosSale`, `inspect` (đơn kết thúc RETURNED, chưa có SALE, còn giữ tiền). Mọi chỗ `completedData(` phải đi cùng `postSale(` trong file (`sales-journal.spec.ts` quét `src/`); e2e `assertMoneyInvariants` thêm bất biến 6-8 (đơn COMPLETED có đúng một SALE, RETURN chỉ khi có SALE, Σ dòng = goods / cogs của bút toán, Σ dòng hoá đơn = tổng hoá đơn; tuỳ chọn `skip: ['SALES_JOURNAL']` cho suite dựng đơn COMPLETED thẳng vào bảng: `order-cancel`).
- **Hoá đơn**: `invoice-math.ts` uỷ quyền cho `sales-math.ts`: dòng = giá trị sau giảm giá cả đơn (`allocateProportional`), `discount_amount` = phần giảm đã chia, thêm dòng "Phí vận chuyển" khi `shipping_fee > 0` nên Σ dòng = tổng hoá đơn; `adjustForReturn` dùng `sliceValue` với số đã điều chỉnh từ các hoá đơn điều chỉnh trước, không hoàn dòng phí ship. `GET /invoices` trả thêm `lines[].discountAmount`.
- **Test**: unit `sales-math.spec`, `invoice-math.spec` (viết lại), `sales-journal.spec` (quét cặp completedData/postSale); e2e `order-journey` (một SALE có `business_date`, giá vốn khớp sổ lô; trả hàng hỏng ra RETURN âm đúng bằng số hoàn gợi ý, dòng SALE không đổi; UPDATE bị trigger chặn), `smoke` (đơn quầy trả hàng: SALE + RETURN đối nhau), `order-cancel`, `order-return` (OTHER_INCOME khi giữ cọc).
- **Chưa kiểm chứng / lưu ý**: migration chưa áp lên DB dev / prod (đơn COMPLETED cũ không có bút toán, D9: seed lại dev; prod không có dữ liệu journal nên báo cáo Phase 8 phải chấp nhận khoảng trống trước ngày chạy migration); lát giá trị của hoá đơn điều chỉnh dựa trên dòng hoá đơn gốc còn lát nhật ký dựa trên dòng đơn, hai bên có thể lệch 1 đồng khi có hàng trả trước lúc xuất hoá đơn; OTHER_INCOME chỉ ghi một lần cho mỗi đơn, tiền shipper nộp sau trên đơn RETURNED (`confirm-remittance`) không tự thêm vào; trả một phần lúc đơn RETURNED từ COMPLETED mà hoàn thiếu tiền thì phần giữ không thành OTHER_INCOME.
- **Còn lại**: Phase 8 (stats đọc nhật ký, `/stats/sales-journal`, `/stats/unreconciled`) và Phase 9.

## 2026-11-11 - Sổ cái tiền, Phase 8: thống kê đọc nhật ký doanh thu + báo cáo đối soát

Làm theo `ledger-plan.md` Phase 8 (BE), nhánh `feat/hungld-order-events`, cộng quyết định D1-D9 (D8: tiền shipper nộp là quỹ OWNER, không vào két nào; D9: không backfill, báo cáo chỉ tính nhật ký và nói rõ phần thiếu). Không có migration, không thêm quyền (mọi route dùng `reports:read`), không đổi seed.

- **Thống kê doanh thu đọc `sales_journal_entries` / `_lines`** (`StatsService.journalFilter`: tenant + `business_date` + chi nhánh): `overview`, `revenue`, `revenue-comparison`, `revenue-by-branch`, `top-customers`, `top-products`, `slow-products`, `sales-heatmap`. Kỳ đã qua không đổi khi có hàng trả: bán tháng 9, trả tháng 10 thì tháng 9 giữ nguyên, tháng 10 âm đúng phần trả (e2e `stats-journal`). `fromDate`/`toDate` đổi sang ngày địa phương; số kỳ trước tính trên cùng số ngày liền trước (`previousBusinessDates` trong `stats-math.ts`, có unit test).
- **`grossProfit` đổi nghĩa**: `revenue − costOfGoods (sổ kho lô, hàng trả là số âm) − shippingCost (Shipment.shippingCost thực) − channelFee`; phí ship khách trả đã nằm trong `revenue`. `linesMissingCost` = dòng SALE giữ hàng có `cogs = 0`. `overview` thêm `grossSales`, `returns`, `goodsRevenue`, `shippingRevenue`, `otherIncome`, `costOfGoods`, `shippingCost`, `channelFee`, `returnCount`, `journalGap`.
- **Cơ sở tiền mặt** (từ `cash_flows` / `payments`, không phải `Order.paymentMethod`): `revenue-by-payment-method` = ORDER_PAYMENT − ORDER_REFUND − SALE_CHANGE theo phương thức (thêm `received`, `refunded`, `change`, `basis: 'CASH'`); `revenue-by-staff?groupBy=assignee|creator|collector` (mặc định người phụ trách, trước là người lên đơn); `cashflow` thêm `byCategory`, `byFund` và lọc `category`, `fund`, danh sách giao dịch thêm `category`, `fund`, `sepayLedgerId`; `inventory.stockValue` = Σ lô còn hàng × giá vốn lô.
- **Hai route mới** (`StatsReportsService`): `GET /stats/sales-journal` (bút toán + dòng, phân trang, `totals`) và `GET /stats/unreconciled` (tiền shipper đang giữ, giao dịch SePay cần xử lý, đơn trả dư, tiền chưa gắn đơn, quỹ OWNER, tiền mặt thu tại quầy KHO không có két, hoàn tiền mặt ghi vào két chi nhánh trong khi tiền đi qua shipper / kho, độ phủ của nhật ký). Chi tiết trường: `docs/api-contract-order-flow.md` §5b.
- **Đơn COMPLETED cũ không có bút toán** (trước migration): báo cáo không lỗi, `overview.journalGap.ordersWithoutJournal` và `unreconciled.journalCoverage` cho biết số thiếu. Doanh thu của chúng không xuất hiện ở đâu cho đến khi seed lại.
- **Sửa kèm**: `invoices.service.ts` gán kiểu rõ cho `lineRows` (dòng phí vận chuyển có `orderItemId` null làm `tsc` lỗi); `ai-tools.service.ts` truyền `RevenueByStaffQueryDto` cho công cụ doanh thu theo nhân viên.
- **Test**: unit `stats-math.spec` (ngày địa phương, kỳ trước); e2e mới `test/stats-journal.e2e-spec.ts` (7 ca: kỳ đã qua không đổi, hàng trả âm ở kỳ sau, chuỗi tháng / top sản phẩm / theo người, route nhật ký, phương thức theo tiền thực thu, thu chi theo quỹ và loại, giá trị tồn từ lô, báo cáo chưa khớp).
- **Chưa kiểm chứng / giới hạn**: chưa chạy với dữ liệu lớn (các truy vấn nhật ký dùng chỉ mục `(tenant_id, business_date)` và `(tenant_id, branch_id, business_date)`; câu `journalGap` quét đơn COMPLETED của kỳ); giao dịch SePay không có shop (`tenant_id` null) và `platform_sepay_transactions` chưa có route đọc; OTHER_INCOME của tiền shipper nộp sau khi đơn RETURNED vẫn không vào nhật ký (ghi từ Phase 7); `slow-products`/`top-products` đếm cả dòng món trong combo (doanh thu 0) như bản cũ.
- **Còn lại**: Phase 9 (sổ công nợ nhà cung cấp, lịch sử ngân hàng, lịch sử giá) và FE-D (màn hình dashboard / báo cáo / sổ thu chi).

## 2026-11-11 - Sổ cái tiền, Phase 9: sổ công nợ nhà cung cấp, lịch sử nhận tiền của shop, lịch sử giá

- **Ba migration, ba bảng chỉ-ghi-thêm** (trigger chặn UPDATE như nhật ký doanh thu; DELETE vẫn được cho cascade và dọn dẹp e2e; ngoại lệ duy nhất là `ON DELETE SET NULL` của cột người làm / dòng thu chi): `20261111140000_supplier_debt_ledger` (`supplier_debt_entries`, kèm một dòng OPENING cho mọi NCC đang nợ), `20261111150000_tenant_banking_history` (`tenant_banking_changes`), `20261111160000_product_price_history` (`product_item_price_changes`). Tên chỉ mục của bảng giá đã rút gọn đúng 63 ký tự để Prisma không báo lệch.
- **Công nợ NCC**: mỗi lần `outstanding_debt` đổi có một dòng cùng transaction (số đổi có dấu, dư sau, chứng từ STOCK_MOVEMENT / PRODUCTION_REQUEST / CASH_FLOW, người làm hoặc hệ thống). `SupplierService.charge` nhận thêm `SupplierDebtRef`; hai nơi gọi (nhận phiếu nhập, nhận hàng xưởng) truyền người nhận + chứng từ. `payDebt` ghi dòng PAYMENT gắn dòng thu chi SUPPLIER_PAYMENT. Tiền hàng nhận tính bằng số nguyên đồng (`toDong` / `sumDong`) thay cho tổng float. Không còn nơi nào khác ghi `outstanding_debt` ngoài seed test (đã sửa để ghi cả dòng sổ).
- **Quyết định D8 cho trả NCC bằng tiền mặt**: mặc định quỹ OWNER; gửi `locationId` thì tiền ra từ két địa điểm đó (quỹ DRAWER, vào đối soát két nếu là chi nhánh). Người trả chỉ chọn được nơi mình làm việc (`canActAt`), sai thì 404 `LOCATION_NOT_FOUND`. `POST /suppliers/:id/payments` đổi chữ ký service (nhận `AuthUser`), response không đổi.
- **Lịch sử nhận tiền**: `PUT /tenant/me`, `PUT /tenant/banking`, `PUT /tenant/:id/sepay-key` và cron đồng bộ SePay ghi `{trường: {from, to}}`; key webhook không bao giờ được lưu, chỉ `{keyChanged: true}`. Số tài khoản đổi kéo theo liên kết / key bị xoá cũng nằm trong cùng một dòng. Đồng bộ SePay ghi từng shop khi lệnh có điều kiện thật sự đổi dòng (hai lần chạy đua không ghi đôi), người làm null, nguồn SEPAY_SYNC. Route đọc: `GET /tenant/banking/history` (`tenants:update`).
- **Lịch sử giá**: một dòng cho mỗi giá thật sự đổi (so theo đồng) ở tạo mặt hàng (from null), sửa mặt hàng, biến thể mới / đổi giá bán qua thuộc tính, hàng may đo (sao giá hàng gốc), và giá vốn combo tự tính lại (người làm = người sửa món con kéo theo). Route đọc: `GET /products/items/:itemId/price-history` (`products:read`).
- **Không thêm quyền nào**, không động tới seed `CATALOG`. `assertMoneyInvariants` thêm bất biến 9 (dư nợ = Σ sổ, dư sau là số lũy kế, mỗi dòng PAYMENT khớp một dòng thu chi SUPPLIER_PAYMENT cùng số tiền; bỏ được bằng `skip: ['SUPPLIER_DEBT']`); `deleteTenantMoneyTrail` xoá thêm ba bảng.
- **Test**: unit `tenant-banking-history.spec` (key không lộ), `product-price-history.spec`; e2e `smoke` thêm ca "supplier debt ledger and price history" (CHARGE khi nhận, PAYMENT mặc định OWNER và theo địa điểm DRAWER, Σ sổ = dư nợ, UPDATE bị trigger chặn, giá tạo / đổi / đổi lại cùng giá không ghi) và đoạn lịch sử nhận tiền sau `PUT /tenant/banking`.
- **Chưa kiểm chứng / giới hạn**: dữ liệu thật có nợ NCC từ trước chỉ có dòng OPENING, không có lịch sử trước đó; lịch sử giá và nhận tiền chỉ có từ lúc triển khai (không backfill); giá vốn của lô (`inventory_lots.unit_cost`) vẫn là sổ riêng, `product_item_price_changes` chỉ theo giá danh mục; `tenants:update` là quyền đọc lịch sử nhận tiền vì catalog không có cặp đọc riêng; chưa thử migration trên bản sao dữ liệu dev / prod.
- **Còn lại**: FE-D (dashboard / báo cáo / sổ thu chi) và màn hình xem ba lịch sử trên.

## 2026-11-11 - Sửa tiền giữ treo (giao thất bại không hoàn) + việc nhỏ cuối sổ tiền

Quyết định của user: "giữ tiền treo, quyết định sau". Trước đó `confirm-failed-delivery` không có `refund` làm `inspect` ghi ngay `OTHER_INCOME` (`RETURN_KEPT`) cho toàn bộ cọc, mà `RETURNED` là trạng thái cuối và `refund-excess` chỉ hoàn phần dư, nên cọc không còn đường hoàn.

- **Thiết kế**: "treo" là quy tắc SUY RA (không thêm cột): đơn `RETURNED` / `CANCELLED`, không có SALE, không có OTHER_INCOME, tiền giữ (thu − hoàn − thối) > 0 (`orders/held-undecided.ts`: `heldUndecidedOf`, `loadHeldUndecided`, bản SQL cho báo cáo). Chọn suy ra vì không thể lệch với `payments` và sổ doanh thu; đánh đổi: tiền thu thêm sau khi đã quyết định không được cờ (OTHER_INCOME vẫn một lần mỗi đơn).
- **`inspect`**: chỉ ghi `OTHER_INCOME` khi người kiểm có nêu `refund` (kể cả 0). Giao thất bại "Chưa hoàn" không ghi gì.
- **Route mới `POST /orders/:id/settle-held`** (`returns:inspect`, không đổi seed): `{ action: REFUND | KEEP, amount?, method?, note? }`. Khoá đơn, tính lại số treo sau khoá (0 → 409 `ORDER_NO_HELD_MONEY`, nên bấm hai lần chỉ một tác dụng). REFUND dùng `recordRefund` cap = số treo (mặc định hoàn hết; phần dư vẫn treo; event `REFUNDED` reason `HELD_DECISION`). KEEP ghi `OTHER_INCOME` nguồn `HELD_DECISION` ở ngày quyết định + event mới `HELD_KEPT`.
- **Trường / mã mới**: `paymentSummary.heldUndecided`; `GET /stats/unreconciled` thêm `heldUndecided { count, amount, items }`; `ErrorCode.ORDER_NO_HELD_MONEY`; `SalesJournalSource.HELD_DECISION`; `OrderEventType.HELD_KEPT`.
- **Migration `20261111170000_order_events_append_only_held_kept`**: trigger `order_events_no_update` (chặn UPDATE, DELETE và `SET NULL` của `actor_id` vẫn được) + tạo lại CHECK loại sự kiện thêm `HELD_KEPT`.
- **"Cần xử lý" một định nghĩa**: `sepay-transactions/sepay-needs-action.ts` (`sepayNeedsActionWhere`) dùng cho `GET /sepay-transactions?unresolved=true` và `/stats/unreconciled` (SETTLED_PARTIAL mà đơn đã PAID thì không cần xử lý).
- **FE**: thẻ Thanh toán hiện "Shop đang giữ X chưa quyết định" + nút "Quyết định" (`settle-held-dialog.tsx`: Hoàn tiền / Giữ lại có xác nhận), `orderJourneyApi.settleHeld`, mã lỗi tiếng Việt, mục mới ở `/reports/unreconciled`, nhãn event `HELD_KEPT` ở lịch sử đơn.
- **Tài liệu**: `Ikiot_BE/CLAUDE.md` (sửa dòng cũ: Phase 1-9, hạn QR đơn quầy có `expires_at`, ba trường hợp webhook `success:false`, mục "Held money"), `api-contract-order-flow.md`, `docs/payment-flow.md` (3.7, mới 3.7b, 6, 7.3, 8.2, 9.3 bỏ các điểm đã sửa).
- **Test**: e2e `order-return` (4 ca mới: không OTHER_INCOME khi Chưa hoàn, refund 0 giữ ngay, hoàn một phần rồi KEEP + bấm đôi + event + báo cáo, từ chối đơn chưa kết thúc), `sepay-ledger` (quy tắc "cần xử lý"). Gate: unit 619/619, e2e 473/473 (34 suite), FE tsc sạch.
- **Chưa làm / lưu ý**: migration chưa chạy trên dev/prod (đã `migrate deploy` trên DB local). Chưa thêm bất biến vào `assertMoneyInvariants` (tiền treo là trạng thái hợp lệ; ghi đã có trigger + unique một phần bảo vệ).

## 2026-11-10 – Két quên chốt: đối soát theo khoảng thời gian của phiên, cảnh báo và nhắc buổi sáng

- **Đối soát theo khoảng thật của phiên** (`sessionWindow`: lúc mở → lúc chốt, hoặc tới hiện tại nếu chưa chốt), không theo ngày giao dịch nữa. Trước đây két quên chốt, chốt muộn hôm sau thì báo thừa đúng bằng tiền mặt hôm sau, còn hôm sau không có két nào. Cột `closed_at` dùng của migration `20261111090000_money_foundations` bên dev (cùng backfill từ `updated_at` cho phiên đã CLOSED, `finalize` ghi cột này); migration `20261110100000_cash_drawer_closed_at` của nhánh này đã bỏ khi rebase vì trùng cột. Báo cáo theo khoảng ngày cũng lọc `fund = DRAWER` như dev. Tiền thu trước lúc mở két hoặc sau lúc chốt không thuộc két nào (cố ý). Smoke e2e trước đây chờ một đơn bán sau khi chốt bị cộng vào két đã chốt; giờ kiểm điều ngược lại.
- **Két quá hạn** = còn OPEN nhưng thuộc ngày giao dịch đã qua (`isOverdue`, một bản duy nhất). Response có `overdue`; `GET /cash-drawer-sessions/overdue` (quyền `read`/`read_own`, không lọc theo `read_own`, chỉ trả ngày, chi nhánh, người giữ). Két quá hạn không bàn giao được và chi nhánh không mở két mới được (`CASH_DRAWER_OVERDUE`, kèm `sessionId`). Vẫn cho START và END không bàn giao, vì đó là đường duy nhất để chốt.
- **Không chặn bán hàng**, chỉ cảnh báo ở màn bán tại quầy. Chặn bán là quyết định của chủ shop, chưa có cài đặt.
- **Cron 07:00** (`CashDrawerCronService`) nhắc quản lý chi nhánh (không có thì chủ shop) mỗi sáng tới khi két được chốt. Thêm `NotificationService.managersOfLocations` (bản gom nhiều địa điểm); `managersOfLocation` gọi qua nó.
- FE: banner "Két ngày dd/MM chưa chốt" ở màn két và màn bán tại quầy, nút "Vào chốt két" cho người có `cash_drawers:finalize`; màn chi tiết két quá hạn ẩn ô bàn giao; mở két bị chặn thì toast có nút dẫn tới két cũ.

**Đã kiểm chứng:** `tsc`, lint, build, `check-permissions`, unit 521/521, `test:e2e` 376/376 chạy tuần tự (`--runInBand`) trên `ikiot_e2e`. FE: `tsc` sạch, không thêm lỗi lint.
**Chưa kiểm chứng:** chưa bấm thử trên dev; cron chỉ được gọi trực tiếp trong e2e, chưa chờ nó tự chạy lúc 07:00. Chạy `test:e2e` song song (mặc định) thì smoke lỗi ngẫu nhiên ở các bước không liên quan tới két (các file e2e dùng chung database) - chạy tuần tự thì qua hết.
**Prod:** không có migration riêng (cột dùng của `money_foundations`).

## 2026-11-11 – Seed shop thời trang, tên nhân viên test giống người thật

- **`ikiot_db` (local) đã bị truncate toàn bộ** (trừ `_prisma_migrations`) theo yêu cầu, rồi `deploy:migrate` 3 migration còn thiếu (`warehouse_can_sell`, `permission_catalog_missing_pairs`, `cash_drawer_closed_at`) và seed lại: `prisma db seed` → `seed-account-role.ts` → `seed-fashion.ts`.
- **`seed-account-role.ts`**: tên tài khoản là tên người thật kèm vai trò ở cuối `firstName` (app hiển thị `lastName firstName`), vd. "Nguyễn Hoàng Hải (Shipper)", chủ shop "Nguyễn Thị Mai (Chủ shop)". SĐT, mật khẩu, role, nơi phân công không đổi. Bảng U0–U9 trong `docs/tai-khoan-test-hanh-trinh.md` đã cập nhật theo.
- **`seed-fashion.ts`** (mới, thay cho seed nội thất): đổi tên shop thành "Thời trang Demo"; 8 danh mục, 3 thương hiệu (Adidas, Nike, IKI Studio), 5 khách, 16 sản phẩm / 87 SKU (màu × size). Hàng Adidas/Nike nhập từ 2 nhà phân phối (Supplier GOODS, phiếu nhập SUPPLIER); hàng IKI Studio `isManufacturable`, tồn đầu qua YCSX000001/000002 COMPLETED + phiếu nhập WORKSHOP từ "Xưởng may Phúc Thịnh"; YCSX000003 SENT chưa nhận để thử bước nhận hàng xưởng. Nhập qua `InventoryService.openLot` nên Σ lot = stock (đã kiểm: 856 = 856).
- `seed-c5-delivery.ts` / `seed-c6-pack.ts` / `seed-furniture-test.ts` dựa vào SKU nội thất - không chạy chung với seed thời trang.

**Đã kiểm chứng:** `tsc` sạch (gồm file seed), chạy lại `seed-fashion.ts` không tạo trùng.
**Chưa kiểm chứng:** chưa mở thử trên dashboard; kịch bản K1–K11 trong tài liệu test viết cho SKU nội thất nên không áp dụng trên dữ liệu này.
