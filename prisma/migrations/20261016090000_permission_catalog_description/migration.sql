-- Mô tả cho từng quyền trong danh mục (màn Vai trò hiện dưới ô chọn). Mã `resource:action` giữ nguyên vì
-- `role_permissions` trỏ vào nó; seed ghi mô tả, câu UPDATE dưới đây để môi trường đã seed có ngay mà không
-- phải seed lại (DB mới chưa có dòng nào thì nó không làm gì).
ALTER TABLE "permission_catalog" ADD COLUMN "description" TEXT;

UPDATE "permission_catalog"
SET "description" = 'Bấm "Bắt đầu vận chuyển" ở đơn hàng (Đã lấy hàng → Đang vận chuyển), tức xác nhận hàng đã giao cho ĐVVC: trừ tồn kho và gỡ phần hàng đang giữ cho đơn. Chỉ làm được tại kho xuất mình được phân công. Người phụ trách đơn cũng cần quyền này.'
WHERE "resource" = 'orders' AND "action" = 'ship';
