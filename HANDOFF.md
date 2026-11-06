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
