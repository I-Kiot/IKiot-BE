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
